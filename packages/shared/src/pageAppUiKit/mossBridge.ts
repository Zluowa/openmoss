// FILE: mossBridge.ts
// Purpose: Unified runtime client wrapper over `window.moss.use(...)` for Moss UI Kit,
// calling native `chat`, `mossbot`, and `media` when available and falling back cleanly to `ai`.
// Layer: Shared Page App UI Kit

export interface MossRuntimeHandle {
  readonly use?: (capability: string) => Promise<unknown>;
}

export interface MossAskParams {
  readonly prompt: string;
  readonly selectionText?: string;
  readonly context?: string;
  readonly appTitle?: string;
  readonly preferSidechat?: boolean;
  readonly onText?: (delta: string, fullText: string) => void;
}

export interface MossAskOutcome {
  readonly via: "chat" | "ai" | "fallback";
  readonly text: string;
  readonly openedSidechat?: boolean;
}

export interface MossbotJoinOutcome {
  readonly via: "mossbot" | "fallback";
  readonly joined: boolean;
  readonly statusText: string;
}

export interface MossbotSummaryOutcome {
  readonly via: "mossbot" | "chat" | "ai" | "fallback";
  readonly summary: string;
}

export interface MossMediaOutcome {
  readonly via: "media" | "chat" | "ai" | "fallback";
  readonly kind: "image" | "video";
  readonly url?: string;
  readonly jobId?: string;
  readonly status: "ready" | "pending" | "fallback";
  readonly text?: string;
}

export interface MossVoiceTranscriptOutcome {
  readonly via: "voice" | "fallback";
  readonly text: string;
  readonly status: "recorded" | "listening" | "stopped" | "fallback";
}

export interface MossVoiceSpeakOutcome {
  readonly via: "voice" | "fallback";
  readonly speaking: boolean;
  readonly statusText: string;
}

export interface MossRealtimeVoiceOutcome {
  readonly via: "voice" | "fallback";
  readonly active: boolean;
  readonly sessionId?: string;
  readonly transcript?: string;
  readonly statusText: string;
}

interface ChatCapability {
  readonly openSidechat?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly summon?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly ask?: (input: unknown, opts?: Record<string, unknown>) => Promise<unknown>;
}

interface AiCapability {
  readonly ask?: (
    input: unknown,
    opts?: {
      readonly system?: string;
      readonly maxTokens?: number;
      readonly onText?: (delta: string) => void;
    },
  ) => Promise<unknown>;
}

interface MossbotCapability {
  readonly joinMeeting?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly summarizeMeeting?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly askInMeeting?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly postNote?: (input: Record<string, unknown>) => Promise<unknown>;
}

interface MediaCapability {
  readonly generateImage?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly generateVideo?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly getJob?: (id: string) => Promise<unknown>;
}

interface VoiceCapability {
  readonly transcribe?: (input?: Record<string, unknown>) => Promise<unknown>;
  readonly startListening?: (input?: Record<string, unknown>) => Promise<unknown>;
  readonly stopListening?: (input?: Record<string, unknown>) => Promise<unknown>;
  readonly speak?: (input: Record<string, unknown>) => Promise<unknown>;
  readonly stopSpeaking?: () => Promise<unknown>;
  readonly startRealtimeSession?: (input?: Record<string, unknown>) => Promise<unknown>;
  readonly stopRealtimeSession?: (input?: Record<string, unknown>) => Promise<unknown>;
}

function getRuntime(): MossRuntimeHandle | null {
  if (typeof globalThis === "undefined") return null;
  const candidate = (globalThis as { moss?: MossRuntimeHandle }).moss;
  return candidate && typeof candidate.use === "function" ? candidate : null;
}

async function tryUse<T>(name: string): Promise<T | null> {
  const runtime = getRuntime();
  if (!runtime?.use) return null;
  try {
    const cap = await runtime.use(name);
    return cap && typeof cap === "object" ? (cap as T) : null;
  } catch {
    return null;
  }
}

function extractText(result: unknown): string {
  if (typeof result === "string") return result;
  if (result && typeof result === "object") {
    const rec = result as Record<string, unknown>;
    if (typeof rec.text === "string") return rec.text;
    if (typeof rec.summary === "string") return rec.summary;
    if (typeof rec.answer === "string") return rec.answer;
    if (typeof rec.content === "string") return rec.content;
    if (typeof rec.message === "string") return rec.message;
  }
  return "";
}

function isSafeLocalMediaUrl(val: unknown): val is string {
  if (typeof val !== "string" || !val) return false;
  if (val.startsWith("data:") || val.startsWith("blob:") || val.startsWith("/")) {
    return true;
  }
  const ownOrigin = typeof location !== "undefined" ? location.origin : "";
  return Boolean(ownOrigin && ownOrigin !== "null" && val.startsWith(`${ownOrigin}/`));
}

function extractMediaUrl(result: unknown): string | undefined {
  if (!result || typeof result !== "object") return undefined;
  const rec = result as Record<string, unknown>;
  for (const key of ["url", "src", "dataUrl", "imageUrl", "videoUrl", "thumbnailUrl"]) {
    const val = rec[key];
    if (isSafeLocalMediaUrl(val)) {
      return val;
    }
  }
  for (const arrayKey of ["urls", "dataUrls", "assetPaths"]) {
    const list = rec[arrayKey];
    if (Array.isArray(list)) {
      for (const item of list) {
        if (isSafeLocalMediaUrl(item)) {
          return item;
        }
      }
    }
  }
  return undefined;
}

export async function runMossAsk(params: MossAskParams): Promise<MossAskOutcome> {
  const prompt = params.prompt.trim() || "请解读这段内容";
  const chat = await tryUse<ChatCapability>("chat");
  if (chat) {
    if (params.preferSidechat && typeof chat.openSidechat === "function") {
      try {
        const res = await chat.openSidechat({
          prompt,
          ...(params.selectionText ? { selectionText: params.selectionText } : {}),
          ...(params.context ? { context: params.context } : {}),
          ...(params.appTitle ? { appTitle: params.appTitle } : {}),
        });
        const text = extractText(res) || "已在 Moss 侧边栏打开上下文对话。";
        return { via: "chat", text, openedSidechat: true };
      } catch {
        // fall through to chat.ask or ai
      }
    }
    if (typeof chat.ask === "function") {
      let streamed = "";
      try {
        const res = await chat.ask(
          {
            prompt,
            ...(params.selectionText ? { selectionText: params.selectionText } : {}),
            ...(params.context ? { context: params.context } : {}),
            ...(params.appTitle ? { appTitle: params.appTitle } : {}),
          },
          {
            onText: (delta: string) => {
              streamed += delta;
              params.onText?.(delta, streamed);
            },
          },
        );
        const text = streamed || extractText(res);
        if (text) return { via: "chat", text };
      } catch {
        // fall through to ai
      }
    }
    if (typeof chat.summon === "function") {
      try {
        const res = await chat.summon({
          prompt,
          ...(params.selectionText ? { selectionText: params.selectionText } : {}),
          ...(params.context ? { context: params.context } : {}),
        });
        const text = extractText(res) || "已唤醒 Moss 伴读对话。";
        return { via: "chat", text, openedSidechat: true };
      } catch {
        // fall through
      }
    }
  }

  const ai = await tryUse<AiCapability>("ai");
  if (ai && typeof ai.ask === "function") {
    let streamed = "";
    const system = [
      "你是 Moss 原生伴读与助手组件，请用简洁平实的简体中文作答。",
      params.appTitle ? `当前应用：${params.appTitle}` : "",
      params.selectionText ? `用户划选片段：\n${params.selectionText}` : "",
      params.context ? `上下文：\n${params.context}` : "",
    ]
      .filter(Boolean)
      .join("\n\n");
    const res = await ai.ask(prompt, {
      system,
      maxTokens: 800,
      onText: (delta) => {
        streamed += delta;
        params.onText?.(delta, streamed);
      },
    });
    const text = streamed || extractText(res);
    return { via: "ai", text: text || "未收到回答，请重试。" };
  }

  return {
    via: "fallback",
    text: "当前环境未开启对话或 AI 能力，请在 Moss 权限中允许访问后重试。",
  };
}

const DEFAULT_MEETING_ID = "moss-default-meeting";

function resolveMeetingId(meetingId?: string): string {
  const trimmed = meetingId?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : DEFAULT_MEETING_ID;
}

export async function runMossbotJoin(input: {
  readonly meetingId?: string;
  readonly title: string;
  readonly topic?: string;
}): Promise<MossbotJoinOutcome> {
  const meetingId = resolveMeetingId(input.meetingId);
  const mossbot = await tryUse<MossbotCapability>("mossbot");
  if (mossbot && typeof mossbot.joinMeeting === "function") {
    try {
      const res = await mossbot.joinMeeting({
        meetingId,
        title: input.title,
        ...(input.topic ? { topic: input.topic } : {}),
      });
      const text = extractText(res) || "Mossbot 已加入会议";
      return { via: "mossbot", joined: true, statusText: text };
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    joined: true,
    statusText: "Moss 已进入本地伴会模式",
  };
}

export async function runMossbotSummarize(input: {
  readonly meetingId?: string;
  readonly title: string;
  readonly transcript: string;
}): Promise<MossbotSummaryOutcome> {
  const meetingId = resolveMeetingId(input.meetingId);
  const mossbot = await tryUse<MossbotCapability>("mossbot");
  if (mossbot && typeof mossbot.summarizeMeeting === "function") {
    try {
      const res = await mossbot.summarizeMeeting({
        meetingId,
        title: input.title,
        transcript: input.transcript,
      });
      const summary = extractText(res);
      if (summary) return { via: "mossbot", summary };
    } catch {
      // fallback to chat/ai
    }
  }

  const prompt = `请为会议《${input.title}》生成结构化简体中文纪要（含关键结论与行动项）：\n\n${input.transcript}`;
  const askRes = await runMossAsk({ prompt, context: input.transcript, appTitle: input.title });
  if (askRes.via === "chat" || askRes.via === "ai") {
    return { via: askRes.via, summary: askRes.text };
  }
  return {
    via: "fallback",
    summary: `《${input.title}》会议纪要占位：\n当前环境未开启 Mossbot 或 AI 能力，已整理会议记录共 ${input.transcript.length} 字。`,
  };
}

export async function runMossbotAsk(input: {
  readonly meetingId?: string;
  readonly title: string;
  readonly prompt: string;
  readonly transcript: string;
}): Promise<MossbotSummaryOutcome> {
  const meetingId = resolveMeetingId(input.meetingId);
  const mossbot = await tryUse<MossbotCapability>("mossbot");
  if (mossbot && typeof mossbot.askInMeeting === "function") {
    try {
      const res = await mossbot.askInMeeting({
        meetingId,
        title: input.title,
        question: input.prompt,
        transcript: input.transcript,
      });
      const summary = extractText(res);
      if (summary) return { via: "mossbot", summary };
    } catch {
      // fallback below
    }
  }
  const askRes = await runMossAsk({
    prompt: input.prompt,
    context: input.transcript,
    appTitle: input.title,
  });
  return {
    via: askRes.via,
    summary: askRes.text,
  };
}

export async function runMossMediaGenerate(input: {
  readonly kind: "image" | "video";
  readonly prompt: string;
}): Promise<MossMediaOutcome> {
  const media = await tryUse<MediaCapability>("media");
  if (media) {
    try {
      const initial =
        input.kind === "video" && typeof media.generateVideo === "function"
          ? await media.generateVideo({ prompt: input.prompt })
          : typeof media.generateImage === "function"
            ? await media.generateImage({ prompt: input.prompt })
            : null;
      if (initial) {
        const directUrl = extractMediaUrl(initial);
        if (directUrl) {
          return {
            via: "media",
            kind: input.kind,
            url: directUrl,
            status: "ready",
            text: extractText(initial) || "已生成媒体资源",
          };
        }
        const rec = initial as Record<string, unknown>;
        const jobId =
          typeof rec.jobId === "string"
            ? rec.jobId
            : typeof rec.id === "string"
              ? rec.id
              : undefined;
        if (jobId && typeof media.getJob === "function") {
          for (let i = 0; i < 6; i += 1) {
            const job = await media.getJob(jobId);
            const url = extractMediaUrl(job);
            if (url) {
              return {
                via: "media",
                kind: input.kind,
                jobId,
                url,
                status: "ready",
                text: extractText(job) || "已生成媒体资源",
              };
            }
            const jobStatus = (job as Record<string, unknown> | null)?.status;
            if (jobStatus === "failed" || jobStatus === "error") {
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return {
            via: "media",
            kind: input.kind,
            jobId,
            status: "pending",
            text: "已提交媒体生成任务，请稍候查看。",
          };
        }
      }
    } catch {
      // fall through to chat/ai draft
    }
  }

  const draftPrompt =
    input.kind === "video"
      ? `请基于以下需求给出可直接使用的短视频分镜与提示词方案：${input.prompt}`
      : `请基于以下需求给出简洁的画面构图与生图提示词方案：${input.prompt}`;
  const askRes = await runMossAsk({ prompt: draftPrompt });
  return {
    via: askRes.via === "fallback" ? "fallback" : askRes.via,
    kind: input.kind,
    status: "fallback",
    text:
      askRes.via === "fallback"
        ? "当前环境未开启媒体生成能力，可在权限中启用后直接出图。"
        : askRes.text,
  };
}

export async function runMossVoiceStartListening(input?: {
  readonly language?: string;
}): Promise<MossVoiceTranscriptOutcome> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice && typeof voice.startListening === "function") {
    try {
      const res = await voice.startListening(input ?? { language: "zh-CN" });
      return {
        via: "voice",
        text: extractText(res),
        status: "listening",
      };
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    text: "",
    status: "fallback",
  };
}

export async function runMossVoiceStopAndTranscribe(input?: {
  readonly audio?: unknown;
  readonly language?: string;
}): Promise<MossVoiceTranscriptOutcome> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice) {
    try {
      if (typeof voice.stopListening === "function") {
        const stopped = await voice.stopListening();
        const directText = extractText(stopped);
        if (directText) {
          return { via: "voice", text: directText, status: "recorded" };
        }
      }
      if (typeof voice.transcribe === "function") {
        const res = await voice.transcribe(input ?? { language: "zh-CN" });
        const text = extractText(res);
        return {
          via: "voice",
          text: text || "已完成语音识别。",
          status: "recorded",
        };
      }
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    text: "当前环境未开启语音转文字能力，请在 Moss 权限中开启后重试。",
    status: "fallback",
  };
}

export async function runMossVoiceSpeak(input: {
  readonly text: string;
  readonly voice?: string;
}): Promise<MossVoiceSpeakOutcome> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice && typeof voice.speak === "function") {
    try {
      await voice.speak({ text: input.text, ...(input.voice ? { voice: input.voice } : {}) });
      return {
        via: "voice",
        speaking: true,
        statusText: "正在朗读内容",
      };
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    speaking: false,
    statusText: "当前环境未开启语音合成能力。",
  };
}

export async function runMossVoiceStopSpeaking(): Promise<void> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice && typeof voice.stopSpeaking === "function") {
    await voice.stopSpeaking().catch(() => undefined);
  }
}

export async function runMossRealtimeVoiceStart(input?: {
  readonly topic?: string;
  readonly context?: string;
}): Promise<MossRealtimeVoiceOutcome> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice && typeof voice.startRealtimeSession === "function") {
    try {
      const res = await voice.startRealtimeSession(input ?? {});
      const rec = res && typeof res === "object" ? (res as Record<string, unknown>) : {};
      const sessionId =
        typeof rec.sessionId === "string"
          ? rec.sessionId
          : typeof rec.id === "string"
            ? rec.id
            : undefined;
      return {
        via: "voice",
        active: true,
        ...(sessionId ? { sessionId } : {}),
        ...(extractText(res) ? { transcript: extractText(res) } : {}),
        statusText: "Moss 实时语音已连线",
      };
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    active: false,
    statusText: "当前环境未开启实时语音能力，请先授权语音访问。",
  };
}

export async function runMossRealtimeVoiceStop(input?: {
  readonly sessionId?: string;
}): Promise<MossRealtimeVoiceOutcome> {
  const voice = await tryUse<VoiceCapability>("voice");
  if (voice && typeof voice.stopRealtimeSession === "function") {
    try {
      const res = await voice.stopRealtimeSession(input ?? {});
      return {
        via: "voice",
        active: false,
        ...(extractText(res) ? { transcript: extractText(res) } : {}),
        statusText: "实时语音已结束",
      };
    } catch {
      // fallback below
    }
  }
  return {
    via: "fallback",
    active: false,
    statusText: "实时语音已结束",
  };
}
