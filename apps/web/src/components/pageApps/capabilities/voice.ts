// FILE: voice.ts
// Purpose: Shell half of `voice`: guards consent, captures host microphone audio
// (because sandboxed iframes block microphone Permissions-Policy), relays STT/TTS/Realtime
// calls to the Moss server, and streams live state & transcript events back to the frame.
// Layer: Web pageApps capability

import type {
  PageAppVoiceSpeakResult,
  PageAppVoiceStartListeningResult,
  PageAppVoiceStartRealtimeResult,
  PageAppVoiceStopListeningResult,
  PageAppVoiceStopRealtimeResult,
  PageAppVoiceSynthesizeResult,
  PageAppVoiceTranscribeResult,
} from "@moss/contracts";
import {
  PageAppCapabilityError,
  type PageAppShellContext,
  type PageAppShellPlugin,
  type PageAppWatchSink,
} from "@moss/shared/pageAppCapabilityPlugin";

import { encodeVoiceRecordingWav } from "../../../lib/voiceRecorderEncoding";

const TARGET_SAMPLE_RATE = 24_000;
const BUFFER_SIZE = 2_048;

interface ActiveCapture {
  readonly listeningId: string;
  readonly audioContext: AudioContext;
  readonly sourceNode: MediaStreamAudioSourceNode;
  readonly processorNode: ScriptProcessorNode;
  readonly silentGainNode: GainNode;
  readonly stream: MediaStream;
  readonly chunks: Float32Array[];
  readonly sampleRateHz: number;
  readonly startedAt: number;
}

interface VoiceHostSession {
  activeCapture: ActiveCapture | null;
  activeAudio: HTMLAudioElement | null;
  activeRealtimeSessionId: string | null;
  readonly subscribers: Set<(event: unknown) => void>;
}

const sessionsBySignal = new WeakMap<AbortSignal, VoiceHostSession>();

function getSession(signal: AbortSignal): VoiceHostSession {
  let session = sessionsBySignal.get(signal);
  if (session) return session;
  session = {
    activeCapture: null,
    activeAudio: null,
    activeRealtimeSessionId: null,
    subscribers: new Set(),
  };
  sessionsBySignal.set(signal, session);
  signal.addEventListener(
    "abort",
    () => {
      void cleanupSession(session!);
    },
    { once: true },
  );
  return session;
}

function emit(session: VoiceHostSession, event: unknown): void {
  for (const subscriber of [...session.subscribers]) {
    try {
      subscriber(event);
    } catch {
      // Ignore subscriber errors.
    }
  }
}

async function teardownCapture(capture: ActiveCapture): Promise<{
  readonly audioBase64: string;
  readonly sampleRateHz: number;
  readonly durationMs: number;
}> {
  capture.processorNode.onaudioprocess = null;
  capture.sourceNode.disconnect();
  capture.processorNode.disconnect();
  capture.silentGainNode.disconnect();
  capture.stream.getTracks().forEach((track) => track.stop());
  await capture.audioContext.close().catch(() => undefined);

  const encoded = encodeVoiceRecordingWav(capture.chunks, capture.sampleRateHz, TARGET_SAMPLE_RATE);
  if (!encoded) {
    return {
      audioBase64: "",
      sampleRateHz: TARGET_SAMPLE_RATE,
      durationMs: Math.max(0, Math.round(performance.now() - capture.startedAt)),
    };
  }
  const bytes = new Uint8Array(encoded.bytes);
  let binary = "";
  const chunk = 8_192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return {
    audioBase64: btoa(binary),
    sampleRateHz: TARGET_SAMPLE_RATE,
    durationMs: Math.max(1, Math.round(encoded.durationMs)),
  };
}

async function cleanupSession(session: VoiceHostSession): Promise<void> {
  if (session.activeCapture) {
    const capture = session.activeCapture;
    session.activeCapture = null;
    await teardownCapture(capture).catch(() => undefined);
  }
  if (session.activeAudio) {
    session.activeAudio.pause();
    session.activeAudio.src = "";
    session.activeAudio = null;
  }
  if (typeof window !== "undefined" && "speechSynthesis" in window) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // Ignore speechSynthesis teardown failures.
    }
  }
  session.subscribers.clear();
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

async function startHostListening(
  ctx: PageAppShellContext,
  _args: unknown,
): Promise<PageAppVoiceStartListeningResult> {
  const session = getSession(ctx.signal);
  if (session.activeCapture) {
    const old = session.activeCapture;
    session.activeCapture = null;
    await teardownCapture(old).catch(() => undefined);
  }
  if (
    typeof navigator === "undefined" ||
    !navigator.mediaDevices ||
    typeof navigator.mediaDevices.getUserMedia !== "function" ||
    typeof AudioContext === "undefined"
  ) {
    throw new PageAppCapabilityError("unavailable", "不支持麦克风录音");
  }

  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (error) {
    const name = error && typeof error === "object" && "name" in error ? String(error.name) : "";
    if (name === "NotAllowedError" || name === "PermissionDeniedError") {
      throw new PageAppCapabilityError("not_granted", "未获得麦克风权限");
    }
    throw new PageAppCapabilityError("unavailable", "无法打开麦克风");
  }

  const listeningId = `lst_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  const audioContext = new AudioContext();
  const sourceNode = audioContext.createMediaStreamSource(stream);
  const processorNode = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);
  const silentGainNode = audioContext.createGain();
  silentGainNode.gain.value = 0;

  const chunks: Float32Array[] = [];
  processorNode.onaudioprocess = (event) => {
    const channel = event.inputBuffer.getChannelData(0);
    chunks.push(new Float32Array(channel));
  };

  sourceNode.connect(processorNode);
  processorNode.connect(silentGainNode);
  silentGainNode.connect(audioContext.destination);

  session.activeCapture = {
    listeningId,
    audioContext,
    sourceNode,
    processorNode,
    silentGainNode,
    stream,
    chunks,
    sampleRateHz: audioContext.sampleRate || TARGET_SAMPLE_RATE,
    startedAt: performance.now(),
  };

  emit(session, {
    type: "state",
    sessionId: listeningId,
    phase: "listening",
    activity: "listening",
  });

  return {
    listeningId,
    mimeType: "audio/wav",
    sampleRateHz: TARGET_SAMPLE_RATE,
  };
}

async function stopHostListening(
  ctx: PageAppShellContext,
  rawArgs: unknown,
): Promise<PageAppVoiceStopListeningResult> {
  const session = getSession(ctx.signal);
  const args = isRecord(rawArgs) ? rawArgs : {};
  const capture = session.activeCapture;
  if (!capture) {
    throw new PageAppCapabilityError("invalid_argument", "请先开始语音录音");
  }
  session.activeCapture = null;
  const recorded = await teardownCapture(capture);
  emit(session, {
    type: "state",
    sessionId: capture.listeningId,
    phase: "idle",
    activity: null,
  });

  const autoTranscribe = args.autoTranscribe !== false;
  let text: string | null = null;
  if (autoTranscribe && recorded.audioBase64) {
    const transcribed = (await ctx.serverCall("transcribe", {
      audioBase64: recorded.audioBase64,
      mimeType: "audio/wav",
      sampleRateHz: recorded.sampleRateHz,
      durationMs: recorded.durationMs,
      ...(typeof args.language === "string" ? { language: args.language } : {}),
    })) as PageAppVoiceTranscribeResult;
    text = transcribed.text;
    emit(session, {
      type: "transcript",
      sessionId: capture.listeningId,
      role: "user",
      text: transcribed.text,
      isFinal: true,
    });
  }

  return {
    listeningId: capture.listeningId,
    audioBase64: recorded.audioBase64,
    mimeType: "audio/wav",
    sampleRateHz: recorded.sampleRateHz,
    durationMs: recorded.durationMs,
    text,
  };
}

async function speakHost(
  ctx: PageAppShellContext,
  rawArgs: unknown,
): Promise<PageAppVoiceSpeakResult> {
  const args = isRecord(rawArgs) ? rawArgs : {};
  const text = typeof args.text === "string" ? args.text.trim() : "";
  if (!text) {
    throw new PageAppCapabilityError("invalid_argument", "播报文本为空");
  }
  const session = getSession(ctx.signal);
  if (session.activeAudio) {
    session.activeAudio.pause();
    session.activeAudio.src = "";
    session.activeAudio = null;
  }

  emit(session, {
    type: "state",
    phase: "speaking",
    activity: "speaking",
  });

  try {
    const synthesized = (await ctx.serverCall("synthesize", args)) as PageAppVoiceSynthesizeResult;
    if (typeof Audio !== "undefined" && synthesized.audioBase64) {
      const audio = new Audio(`data:${synthesized.mimeType};base64,${synthesized.audioBase64}`);
      session.activeAudio = audio;
      audio.onended = () => {
        if (session.activeAudio === audio) session.activeAudio = null;
        emit(session, { type: "state", phase: "idle", activity: null });
      };
      await audio.play().catch(() => undefined);
    }
    return {
      spoken: true,
      source: "moss",
      voice: synthesized.voice,
    };
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? String(error.code) : "unavailable";
    if (code !== "unavailable") {
      emit(session, { type: "state", phase: "idle", activity: null });
      throw error;
    }
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      const utterance = new SpeechSynthesisUtterance(text);
      if (typeof args.rate === "number" && Number.isFinite(args.rate)) {
        utterance.rate = Math.max(0.5, Math.min(2, args.rate));
      }
      if (typeof args.pitch === "number" && Number.isFinite(args.pitch)) {
        utterance.pitch = Math.max(0.5, Math.min(2, args.pitch));
      }
      utterance.onend = () => {
        emit(session, { type: "state", phase: "idle", activity: null });
      };
      window.speechSynthesis.cancel();
      window.speechSynthesis.speak(utterance);
      return {
        spoken: true,
        source: "browser",
        voice: typeof args.voice === "string" ? args.voice : null,
      };
    }
    emit(session, { type: "state", phase: "idle", activity: null });
    throw error;
  }
}

export const voiceShellPlugin: PageAppShellPlugin = {
  name: "voice",
  consent: "standing",
  modes: ["full", "embed"],
  label: "语音与实时对话",
  purpose: "允许此应用页使用语音输入播报与实时对话",
  rateLimit: { burst: 15, perMinute: 30 },
  async call(ctx, method, args) {
    switch (method) {
      case "listVoices":
        return ctx.serverCall("listVoices", args);
      case "transcribe":
        return ctx.serverCall("transcribe", args);
      case "startListening":
        return startHostListening(ctx, args);
      case "stopListening":
        return stopHostListening(ctx, args);
      case "speak":
        return speakHost(ctx, args);
      case "stopSpeaking": {
        const session = getSession(ctx.signal);
        if (session.activeAudio) {
          session.activeAudio.pause();
          session.activeAudio.src = "";
          session.activeAudio = null;
        }
        if (typeof window !== "undefined" && "speechSynthesis" in window) {
          window.speechSynthesis.cancel();
        }
        emit(session, { type: "state", phase: "idle", activity: null });
        return { stopped: true };
      }
      case "startRealtimeSession": {
        const session = getSession(ctx.signal);
        const started = (await ctx.serverCall(
          "startRealtimeSession",
          args,
        )) as PageAppVoiceStartRealtimeResult;
        session.activeRealtimeSessionId = started.sessionId;
        emit(session, {
          type: "state",
          sessionId: started.sessionId,
          phase: started.status === "active" ? "active" : "ready",
          activity: "listening",
        });
        return started;
      }
      case "stopRealtimeSession": {
        const session = getSession(ctx.signal);
        const input = isRecord(args) ? args : {};
        const targetId =
          typeof input.sessionId === "string" && input.sessionId.trim()
            ? input.sessionId.trim()
            : session.activeRealtimeSessionId;
        const result = (await ctx.serverCall("stopRealtimeSession", {
          ...input,
          ...(targetId ? { sessionId: targetId } : {}),
        })) as PageAppVoiceStopRealtimeResult;
        if (result.sessionId && session.activeRealtimeSessionId === result.sessionId) {
          session.activeRealtimeSessionId = null;
        }
        emit(session, {
          type: "state",
          sessionId: result.sessionId,
          phase: "inactive",
          activity: null,
        });
        return result;
      }
      default:
        throw new PageAppCapabilityError("invalid_argument", `Unknown voice method: ${method}`);
    }
  },
  watch(ctx: PageAppShellContext, method: string, _args: unknown, sink: PageAppWatchSink) {
    if (method !== "events") {
      sink.end(
        new PageAppCapabilityError("invalid_argument", `Unknown voice stream: ${method}`).toJSON(),
      );
      return () => undefined;
    }
    const session = getSession(ctx.signal);
    const handler = (event: unknown) => {
      sink.next(event);
    };
    session.subscribers.add(handler);
    return () => {
      session.subscribers.delete(handler);
    };
  },
};
