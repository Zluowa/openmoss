// FILE: voice.ts
// Purpose: Server half of the `voice` capability: speech-to-text transcription
// via Moss voice gateway, optional Moss TTS synthesis, and Realtime Voice
// session lifecycle via RealtimeVoiceService.
// Layer: Server pages/apps

import { randomUUID } from "node:crypto";

import {
  PAGE_APP_VOICE_MAX_AUDIO_BASE64_CHARS,
  PAGE_APP_VOICE_MAX_INSTRUCTIONS_CHARS,
  PAGE_APP_VOICE_MAX_SPEAK_CHARS,
  ThreadId,
  type PageAppVoiceDescriptor,
  type PageAppVoiceListVoicesResult,
  type PageAppVoiceStartRealtimeResult,
  type PageAppVoiceStopRealtimeResult,
  type PageAppVoiceSynthesizeResult,
  type PageAppVoiceTranscribeResult,
  type RealtimeVoiceId,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";

import type { RealtimeVoiceServiceShape } from "../../../realtimeVoice/Services/RealtimeVoiceService";
import { transcribeVoiceWithMossGateway } from "../../../voiceTranscription";
import type { PageAppServerCapability } from "./types";

const MAX_PER_MINUTE_PER_APP = 30;

const DEFAULT_MOSS_VOICES: readonly PageAppVoiceDescriptor[] = [
  { id: "breeze", displayName: "Breeze", description: "清澈自然的女声" },
  { id: "arbor", displayName: "Arbor", description: "沉稳温和的男声" },
  { id: "cove", displayName: "Cove", description: "温和清晰的讲述音" },
  { id: "ember", displayName: "Ember", description: "富有活力的青年音" },
  { id: "juniper", displayName: "Juniper", description: "明亮流畅的对话音" },
  { id: "maple", displayName: "Maple", description: "亲切舒缓的女声" },
  { id: "sol", displayName: "Sol", description: "清晰朗润的男声" },
  { id: "spruce", displayName: "Spruce", description: "专业克制的播报音" },
  { id: "vale", displayName: "Vale", description: "细腻柔和的对话音" },
];

const VALID_VOICE_IDS = new Set(DEFAULT_MOSS_VOICES.map((voice) => voice.id));

export interface PageAppVoiceGateway {
  readonly listVoices: () => Promise<PageAppVoiceListVoicesResult>;
  readonly transcribe: (input: {
    readonly appId: string;
    readonly audioBase64: string;
    readonly mimeType: string;
    readonly sampleRateHz: number;
    readonly durationMs: number;
    readonly language?: string;
    readonly signal?: AbortSignal;
  }) => Promise<PageAppVoiceTranscribeResult>;
  readonly synthesize: (input: {
    readonly appId: string;
    readonly text: string;
    readonly voice?: string;
    readonly format?: "mp3" | "wav" | "opus";
    readonly signal?: AbortSignal;
  }) => Promise<PageAppVoiceSynthesizeResult>;
  readonly startRealtimeSession: (input: {
    readonly appId: string;
    readonly threadId?: string;
    readonly voice?: string;
    readonly instructions?: string;
    readonly outputModality?: "audio" | "text";
    readonly sdp?: string;
  }) => Promise<PageAppVoiceStartRealtimeResult>;
  readonly stopRealtimeSession: (input: {
    readonly appId: string;
    readonly sessionId?: string;
    readonly reason?: string;
  }) => Promise<PageAppVoiceStopRealtimeResult>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

function normalizeVoiceId(raw: unknown): RealtimeVoiceId {
  if (typeof raw === "string") {
    const candidate = raw.trim().toLowerCase();
    if (VALID_VOICE_IDS.has(candidate)) {
      return candidate as RealtimeVoiceId;
    }
  }
  return "breeze";
}

function mapVoiceError(error: unknown): PageAppCapabilityError {
  if (error instanceof PageAppCapabilityError) return error;
  const code =
    error && typeof error === "object" && "code" in error && typeof error.code === "string"
      ? error.code
      : "";
  if (
    code === "authentication_required" ||
    code === "account_recovery_required" ||
    code === "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED" ||
    code === "VOICE_ACCOUNT_RECOVERY_REQUIRED" ||
    code === "REALTIME_VOICE_ACCOUNT_RECOVERY_REQUIRED"
  ) {
    return fail("authentication_required", "请先登录 Moss 账号后再使用语音能力。");
  }
  if (code === "MOSS_VOICE_AUDIO_TOO_LARGE" || code === "too_large") {
    return fail("too_large", "音频文件过大，请控制在 10 MB 以内。");
  }
  if (
    code === "VOICE_AUDIO_INVALID" ||
    code === "VOICE_AUDIO_TOO_LONG" ||
    code === "invalid_argument"
  ) {
    return fail("invalid_argument", "音频参数无效或时长过长，请重新录制后再试。");
  }
  if (code === "insufficient_credits" || code === "quota_exceeded") {
    return fail("quota_exceeded", "Moss 账户语音额度不足。");
  }
  if (code === "VOICE_ACCOUNT_STARTUP_NOT_READY" || code === "REALTIME_RELAY_UNAVAILABLE") {
    return fail("unavailable", "语音服务正在准备中，请稍后重试。");
  }
  const err = toPageAppCallError(error);
  return fail(err.code, err.message);
}

/** Wires `PageAppVoiceGateway` to Moss account gateway (STT/TTS) and `RealtimeVoiceService`. */
export function makePageAppVoiceGateway(deps: {
  readonly resolveCredential: () => Promise<{
    readonly gatewayBaseUrl: string;
    readonly accessToken: string;
  }>;
  readonly realtimeService?: Pick<
    RealtimeVoiceServiceShape,
    "listVoices" | "claim" | "releaseClaim" | "start" | "stop" | "getState"
  > | null;
  readonly fetchImpl?: typeof fetch;
}): PageAppVoiceGateway {
  const fetchFn = deps.fetchImpl ?? fetch;
  const activeRealtimeSessions = new Map<string, string>();

  return {
    listVoices: async () => {
      if (deps.realtimeService) {
        const result = await Effect.runPromise(Effect.result(deps.realtimeService.listVoices()));
        if (result._tag === "Success") {
          return {
            defaultVoice: result.success.defaultVoice,
            preferredTransport: result.success.preferredTransport,
            voices: result.success.voices,
          };
        }
      }
      return {
        defaultVoice: "breeze",
        preferredTransport: "webrtc",
        voices: DEFAULT_MOSS_VOICES,
      };
    },

    transcribe: async (input) => {
      try {
        const credential = await deps.resolveCredential();
        const result = await transcribeVoiceWithMossGateway({
          request: {
            provider: "codex",
            cwd: `page-app:${input.appId}`,
            mimeType: input.mimeType,
            sampleRateHz: input.sampleRateHz,
            durationMs: input.durationMs,
            audioBase64: input.audioBase64,
          },
          gateway: {
            gatewayBaseUrl: credential.gatewayBaseUrl,
            token: credential.accessToken,
          },
          ...(input.signal ? { signal: input.signal } : {}),
        });
        return {
          text: result.text,
          language: input.language ?? null,
        };
      } catch (error) {
        throw mapVoiceError(error);
      }
    },

    synthesize: async (input) => {
      const credential = await deps.resolveCredential();
      const format = input.format ?? "mp3";
      const voice = normalizeVoiceId(input.voice);
      const url = `${credential.gatewayBaseUrl.replace(/\/+$/u, "")}/v1/audio/speech`;
      const response = await fetchFn(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.accessToken}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini-tts",
          input: input.text,
          voice,
          response_format: format,
        }),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw fail("authentication_required", "请先登录 Moss 账号后再使用语音合成。");
        }
        if (response.status === 402 || response.status === 429) {
          throw fail("quota_exceeded", "Moss 账户语音额度不足或请求过于频繁。");
        }
        throw fail("unavailable", `语音合成服务暂不可用 (${response.status})。`);
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      const mimeType =
        format === "wav" ? "audio/wav" : format === "opus" ? "audio/ogg" : "audio/mpeg";
      return {
        audioBase64: bytes.toString("base64"),
        mimeType,
        voice,
      };
    },

    startRealtimeSession: async (input) => {
      const voice = normalizeVoiceId(input.voice);
      const threadId = ThreadId.makeUnsafe(input.threadId?.trim() || `page-app:${input.appId}`);
      if (deps.realtimeService) {
        const claimResult = await Effect.runPromise(
          Effect.result(
            deps.realtimeService.claim({
              threadId,
              source: "composer-existing",
            }),
          ),
        );
        if (claimResult._tag === "Success") {
          const claim = claimResult.success;
          const startResult = await Effect.runPromise(
            Effect.result(
              deps.realtimeService.start({
                ownerClaimId: claim.ownerClaimId,
                threadId,
                source: "composer-existing",
                voice,
                transport: input.sdp
                  ? { type: "webrtc", sdp: input.sdp }
                  : { type: "websocket-pcm16" },
                outputModality: input.outputModality ?? "audio",
              }),
            ),
          );
          if (startResult._tag === "Success") {
            const started = startResult.success;
            activeRealtimeSessions.set(started.sessionId, input.appId);
            return {
              sessionId: started.sessionId,
              threadId,
              voice,
              transport: started.transport.type,
              status: "active",
              answerSdp: started.transport.type === "webrtc" ? started.transport.sdp : null,
              relayUrl: started.transport.type === "websocket-pcm16" ? started.transport.url : null,
              ticket:
                started.transport.type === "websocket-pcm16" ? started.transport.ticket : null,
              expiresAt:
                started.transport.type === "websocket-pcm16" ? started.transport.expiresAt : null,
            };
          }
          await Effect.runPromise(
            Effect.result(deps.realtimeService.releaseClaim({ ownerClaimId: claim.ownerClaimId })),
          );
          throw mapVoiceError(startResult.failure);
        }
        throw mapVoiceError(claimResult.failure);
      }

      // Preview/test mode without a running RealtimeVoiceService: ensure user is signed in
      // if resolveCredential enforces auth, otherwise issue a structured ready handle.
      await deps.resolveCredential();
      const sessionId = `rtv_${randomUUID()}`;
      activeRealtimeSessions.set(sessionId, input.appId);
      return {
        sessionId,
        threadId,
        voice,
        transport: "server-bridge",
        status: "ready",
      };
    },

    stopRealtimeSession: async (input) => {
      const targetSessionId =
        input.sessionId?.trim() ||
        [...activeRealtimeSessions.entries()].find(([, appId]) => appId === input.appId)?.[0] ||
        null;
      if (!targetSessionId) {
        return { stopped: false, sessionId: null };
      }
      if (deps.realtimeService) {
        const stopResult = await Effect.runPromise(
          Effect.result(
            deps.realtimeService.stop({
              sessionId: targetSessionId,
              reason: input.reason === "surface-unmounted" ? "surface-unmounted" : "user",
            }),
          ),
        );
        if (stopResult._tag === "Failure") {
          throw mapVoiceError(stopResult.failure);
        }
      }
      activeRealtimeSessions.delete(targetSessionId);
      return {
        stopped: true,
        sessionId: targetSessionId,
      };
    },
  };
}

export function makeVoiceCapability(deps: {
  readonly voice?: PageAppVoiceGateway | null;
}): PageAppServerCapability {
  const recentCallsByApp = new Map<string, number[]>();

  const assertRateLimit = (appId: string) => {
    const now = Date.now();
    const calls = (recentCallsByApp.get(appId) ?? []).filter((ts) => now - ts < 60_000);
    if (calls.length >= MAX_PER_MINUTE_PER_APP) {
      throw fail("resource_exhausted", "语音请求过于频繁，请稍后再试。");
    }
    calls.push(now);
    recentCallsByApp.set(appId, calls);
  };

  const requireGateway = () => {
    if (!deps.voice) {
      throw fail("unavailable", "当前环境暂未启用语音能力。");
    }
    return deps.voice;
  };

  return {
    name: "voice",
    consent: "standing",
    call: (ctx, method, rawArgs) =>
      Effect.gen(function* () {
        if (!ctx.viewer.isOwner) {
          return yield* Effect.fail(fail("unavailable", "仅应用页所有者可使用语音能力。"));
        }
        const voice = yield* Effect.try({
          try: requireGateway,
          catch: mapVoiceError,
        });

        switch (method) {
          case "listVoices":
            return yield* Effect.tryPromise({
              try: () => voice.listVoices(),
              catch: mapVoiceError,
            });

          case "transcribe": {
            const validated = yield* Effect.try({
              try: () => {
                assertRateLimit(ctx.app.id);
                if (!isRecord(rawArgs)) {
                  throw fail("invalid_argument", "transcribe 参数必须是对象。");
                }
                const audioBase64 =
                  typeof rawArgs.audioBase64 === "string" ? rawArgs.audioBase64.trim() : "";
                if (!audioBase64) {
                  throw fail("invalid_argument", "audioBase64 不能为空。");
                }
                if (audioBase64.length > PAGE_APP_VOICE_MAX_AUDIO_BASE64_CHARS) {
                  throw fail("too_large", "音频数据超过 10 MB 限制。");
                }
                const mimeType =
                  typeof rawArgs.mimeType === "string" && rawArgs.mimeType.trim()
                    ? rawArgs.mimeType.trim().slice(0, 100)
                    : "audio/wav";
                const sampleRateHz =
                  typeof rawArgs.sampleRateHz === "number" &&
                  Number.isFinite(rawArgs.sampleRateHz) &&
                  rawArgs.sampleRateHz > 0
                    ? Math.round(rawArgs.sampleRateHz)
                    : 24_000;
                const durationMs =
                  typeof rawArgs.durationMs === "number" &&
                  Number.isFinite(rawArgs.durationMs) &&
                  rawArgs.durationMs >= 0
                    ? Math.round(rawArgs.durationMs)
                    : 1_000;
                const language =
                  typeof rawArgs.language === "string" && rawArgs.language.trim()
                    ? rawArgs.language.trim().slice(0, 32)
                    : undefined;
                return { audioBase64, mimeType, sampleRateHz, durationMs, language };
              },
              catch: mapVoiceError,
            });
            return yield* Effect.tryPromise({
              try: (signal) =>
                voice.transcribe({
                  appId: ctx.app.id,
                  audioBase64: validated.audioBase64,
                  mimeType: validated.mimeType,
                  sampleRateHz: validated.sampleRateHz,
                  durationMs: validated.durationMs,
                  ...(validated.language ? { language: validated.language } : {}),
                  signal,
                }),
              catch: mapVoiceError,
            });
          }

          case "synthesize": {
            const validated = yield* Effect.try({
              try: () => {
                assertRateLimit(ctx.app.id);
                if (!isRecord(rawArgs)) {
                  throw fail("invalid_argument", "synthesize 参数必须是对象。");
                }
                const text = typeof rawArgs.text === "string" ? rawArgs.text.trim() : "";
                if (!text) {
                  throw fail("invalid_argument", "播报文本不能为空。");
                }
                if (text.length > PAGE_APP_VOICE_MAX_SPEAK_CHARS) {
                  throw fail(
                    "invalid_argument",
                    `播报文本不能超过 ${PAGE_APP_VOICE_MAX_SPEAK_CHARS} 字符。`,
                  );
                }
                const voiceId =
                  typeof rawArgs.voice === "string" && rawArgs.voice.trim()
                    ? rawArgs.voice.trim()
                    : undefined;
                const format =
                  rawArgs.format === "wav" || rawArgs.format === "opus" || rawArgs.format === "mp3"
                    ? rawArgs.format
                    : "mp3";
                return { text, voiceId, format } as const;
              },
              catch: mapVoiceError,
            });
            return yield* Effect.tryPromise({
              try: (signal) =>
                voice.synthesize({
                  appId: ctx.app.id,
                  text: validated.text,
                  ...(validated.voiceId ? { voice: validated.voiceId } : {}),
                  format: validated.format,
                  signal,
                }),
              catch: mapVoiceError,
            });
          }

          case "startRealtimeSession": {
            const validated = yield* Effect.try({
              try: () => {
                assertRateLimit(ctx.app.id);
                const opts = isRecord(rawArgs) ? rawArgs : {};
                const instructions =
                  typeof opts.instructions === "string" ? opts.instructions.trim() : undefined;
                if (instructions && instructions.length > PAGE_APP_VOICE_MAX_INSTRUCTIONS_CHARS) {
                  throw fail(
                    "invalid_argument",
                    `实时语音指令不能超过 ${PAGE_APP_VOICE_MAX_INSTRUCTIONS_CHARS} 字符。`,
                  );
                }
                const outputModality: "audio" | "text" | undefined =
                  opts.outputModality === "text" || opts.outputModality === "audio"
                    ? opts.outputModality
                    : undefined;
                return {
                  ...(typeof opts.threadId === "string" && opts.threadId.trim()
                    ? { threadId: opts.threadId.trim() }
                    : {}),
                  ...(typeof opts.voice === "string" && opts.voice.trim()
                    ? { voice: opts.voice.trim() }
                    : {}),
                  ...(instructions ? { instructions } : {}),
                  ...(outputModality ? { outputModality } : {}),
                  ...(typeof opts.sdp === "string" && opts.sdp.trim() ? { sdp: opts.sdp } : {}),
                };
              },
              catch: mapVoiceError,
            });
            return yield* Effect.tryPromise({
              try: () =>
                voice.startRealtimeSession({
                  appId: ctx.app.id,
                  ...validated,
                }),
              catch: mapVoiceError,
            });
          }

          case "stopRealtimeSession": {
            const opts = isRecord(rawArgs) ? rawArgs : {};
            return yield* Effect.tryPromise({
              try: () =>
                voice.stopRealtimeSession({
                  appId: ctx.app.id,
                  ...(typeof opts.sessionId === "string" && opts.sessionId.trim()
                    ? { sessionId: opts.sessionId.trim() }
                    : {}),
                  ...(typeof opts.reason === "string" && opts.reason.trim()
                    ? { reason: opts.reason.trim() }
                    : {}),
                }),
              catch: mapVoiceError,
            });
          }

          default:
            return yield* Effect.fail(fail("invalid_argument", `Unknown voice method: ${method}`));
        }
      }),
  };
}
