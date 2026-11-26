// FILE: mossbot.ts
// Purpose: Server half of the `mossbot` capability: lets meeting / workspace
// Page Apps list available Mossbot assistants, invite them into a live meeting,
// post structured notes, ask in meeting context, and generate structured summaries.
// Layer: Server pages/apps

import { randomUUID } from "node:crypto";

import {
  PAGE_APP_MOSSBOT_MAX_NOTE_CHARS,
  PAGE_APP_MOSSBOT_MAX_TRANSCRIPT_CHARS,
  type PageAppMossbotAskInMeetingResult,
  type PageAppMossbotInfo,
  type PageAppMossbotJoinMeetingResult,
  type PageAppMossbotPostNoteResult,
  type PageAppMossbotSummarizeMeetingResult,
} from "@moss/contracts";
import { PageAppCapabilityError, toPageAppCallError } from "@moss/shared/pageAppCapabilityPlugin";
import { Effect } from "effect";

import type { PageAppAiGateway } from "../aiGateway";
import type { PageAppServerCallContext, PageAppServerCapability } from "./types";

const MAX_MEETINGS_PER_APP = 100;
const MAX_NOTES_PER_MEETING = 500;
const BUILTIN_ASSISTANT: PageAppMossbotInfo = {
  id: "moss-meeting-assistant",
  name: "Moss 会议助手",
  icon: null,
  color: null,
};

export interface PageAppMossbotGateway {
  readonly listBots: () => Promise<readonly PageAppMossbotInfo[]>;
  readonly joinMeeting: (input: {
    readonly appId: string;
    readonly meetingId: string;
    readonly title: string;
    readonly topic?: string;
    readonly botId?: string;
    readonly participants?: readonly string[];
  }) => Promise<PageAppMossbotJoinMeetingResult>;
  readonly postNote: (input: {
    readonly appId: string;
    readonly meetingId: string;
    readonly author: string;
    readonly text: string;
    readonly kind: "note" | "transcript" | "decision" | "action";
  }) => Promise<PageAppMossbotPostNoteResult>;
  readonly summarizeMeeting: (input: {
    readonly appId: string;
    readonly meetingId: string;
    readonly prompt?: string;
    readonly transcript?: string;
    readonly focus?: string;
  }) => Promise<PageAppMossbotSummarizeMeetingResult>;
  readonly askInMeeting: (input: {
    readonly appId: string;
    readonly meetingId: string;
    readonly question: string;
    readonly transcript?: string;
    readonly botId?: string;
  }) => Promise<PageAppMossbotAskInMeetingResult>;
}

interface StoredMeetingNote {
  readonly id: string;
  readonly author: string;
  readonly text: string;
  readonly kind: "note" | "transcript" | "decision" | "action";
  readonly createdAt: string;
}

interface StoredMeetingSession {
  readonly appId: string;
  readonly meetingId: string;
  title: string;
  topic?: string;
  roomId: string | null;
  bots: readonly PageAppMossbotInfo[];
  readonly notes: StoredMeetingNote[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const fail = (code: string, message: string) => new PageAppCapabilityError(code, message);

function sanitizeRoomRequestId(appId: string, meetingId: string): string {
  const safe = `pa-${appId}-${meetingId}`.replace(/[^a-zA-Z0-9_-]/gu, "-").slice(0, 128);
  return safe || `pa-${randomUUID()}`;
}

function parseJsonSummary(rawText: string): {
  summary: string;
  keyPoints: string[];
  actionItems: string[];
  decisions: string[];
} | null {
  try {
    const trimmed = rawText.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/iu, "$1");
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (!isRecord(parsed)) return null;
    const toStringList = (val: unknown): string[] =>
      Array.isArray(val)
        ? val.filter((v): v is string => typeof v === "string" && Boolean(v.trim()))
        : [];
    const summary = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
    if (!summary) return null;
    return {
      summary,
      keyPoints: toStringList(parsed.keyPoints),
      actionItems: toStringList(parsed.actionItems),
      decisions: toStringList(parsed.decisions),
    };
  } catch {
    return null;
  }
}

export function makeMossbotCapabilityGateway(deps: {
  readonly ai: PageAppAiGateway;
  readonly listActiveBots?: () => Promise<readonly PageAppMossbotInfo[]>;
  readonly ensureRoom?: (input: {
    readonly requestId: string;
    readonly name: string;
    readonly botIds: readonly string[];
  }) => Promise<{ readonly roomId: string } | null>;
  readonly postToRoom?: (input: {
    readonly roomId: string;
    readonly text: string;
  }) => Promise<void>;
  readonly now?: () => string;
}): PageAppMossbotGateway {
  const now = deps.now ?? (() => new Date().toISOString());
  const meetings = new Map<string, StoredMeetingSession>();

  const keyFor = (appId: string, meetingId: string) => `${appId}\u0000${meetingId}`;

  const getOrCreateSession = (
    appId: string,
    meetingId: string,
    defaults?: { readonly title?: string; readonly topic?: string },
  ): StoredMeetingSession => {
    const key = keyFor(appId, meetingId);
    const existing = meetings.get(key);
    if (existing) {
      if (defaults?.title) existing.title = defaults.title;
      if (defaults?.topic) existing.topic = defaults.topic;
      return existing;
    }
    if (meetings.size >= MAX_MEETINGS_PER_APP) {
      const oldestKey = meetings.keys().next().value;
      if (oldestKey) meetings.delete(oldestKey);
    }
    const created: StoredMeetingSession = {
      appId,
      meetingId,
      title: defaults?.title || "应用内会议",
      ...(defaults?.topic ? { topic: defaults.topic } : {}),
      roomId: null,
      bots: [BUILTIN_ASSISTANT],
      notes: [],
    };
    meetings.set(key, created);
    return created;
  };

  const formatMeetingContext = (
    session: StoredMeetingSession,
    extraTranscript?: string,
  ): string => {
    const parts: string[] = [`会议标题：${session.title}`];
    if (session.topic) parts.push(`会议议题：${session.topic}`);
    if (session.notes.length > 0) {
      parts.push(
        "会议记录：\n" +
          session.notes.map((note) => `- [${note.kind}] ${note.author}: ${note.text}`).join("\n"),
      );
    }
    if (extraTranscript?.trim()) {
      parts.push(
        `补充记录/转录：\n${extraTranscript.trim().slice(0, PAGE_APP_MOSSBOT_MAX_TRANSCRIPT_CHARS)}`,
      );
    }
    return parts.join("\n\n");
  };

  const askAi = async (prompt: string, system: string, json = false) => {
    const controller = new AbortController();
    let text = "";
    let model = "";
    try {
      for await (const event of deps.ai.ask(
        { input: prompt, system, json, tier: "default" },
        controller.signal,
      )) {
        if (event.type === "done") {
          text = event.text;
          model = event.model;
        }
      }
    } finally {
      controller.abort();
    }
    return { text, model };
  };

  return {
    listBots: async () => {
      const active = deps.listActiveBots ? await deps.listActiveBots().catch(() => []) : [];
      return active.length > 0 ? active : [BUILTIN_ASSISTANT];
    },
    joinMeeting: async ({ appId, meetingId, title, topic, botId }) => {
      const available = deps.listActiveBots ? await deps.listActiveBots().catch(() => []) : [];
      const chosen =
        (botId ? available.find((bot) => bot.id === botId) : undefined) ??
        available[0] ??
        BUILTIN_ASSISTANT;
      const session = getOrCreateSession(appId, meetingId, {
        title,
        ...(topic !== undefined ? { topic } : {}),
      });
      session.bots = [chosen];

      if (deps.ensureRoom && chosen.id !== BUILTIN_ASSISTANT.id) {
        try {
          const created = await deps.ensureRoom({
            requestId: sanitizeRoomRequestId(appId, meetingId),
            name: title,
            botIds: [chosen.id],
          });
          if (created?.roomId) session.roomId = created.roomId;
        } catch {
          // Keep meeting operable with built-in AI fallback when room creation fails.
        }
      }

      return {
        meetingId: session.meetingId,
        roomId: session.roomId,
        title: session.title,
        joined: true,
        bots: [...session.bots],
        notesCount: session.notes.length,
      };
    },
    postNote: async ({ appId, meetingId, author, text, kind }) => {
      const session = getOrCreateSession(appId, meetingId);
      const note: StoredMeetingNote = {
        id: randomUUID(),
        author,
        text,
        kind,
        createdAt: now(),
      };
      session.notes.push(note);
      if (session.notes.length > MAX_NOTES_PER_MEETING) {
        session.notes.splice(0, session.notes.length - MAX_NOTES_PER_MEETING);
      }
      if (session.roomId && deps.postToRoom) {
        await deps
          .postToRoom({
            roomId: session.roomId,
            text: `[${kind}] ${author}: ${text}`,
          })
          .catch(() => undefined);
      }
      return {
        meetingId,
        noteId: note.id,
        notesCount: session.notes.length,
      };
    },
    summarizeMeeting: async ({ appId, meetingId, prompt, transcript, focus }) => {
      const session = getOrCreateSession(appId, meetingId);
      const context = formatMeetingContext(session, transcript);
      const instruction = [
        "你是入驻当前会议的 Moss 智能助手，请整理真实、精炼、结构化的中文会议纪要。",
        '严格返回 JSON 对象：{"summary": string, "keyPoints": string[], "actionItems": string[], "decisions": string[]}。',
        focus ? `重点关注：${focus}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      const userPrompt = `${context}\n\n${prompt?.trim() || "请生成本次会议的结构化纪要、核心要点、待办行动项与决议。"}`;
      const { text, model } = await askAi(userPrompt, instruction, true);
      const parsed = parseJsonSummary(text);
      const botName = session.bots[0]?.name ?? BUILTIN_ASSISTANT.name;
      return {
        meetingId,
        summary: parsed?.summary ?? text.trim(),
        keyPoints: parsed?.keyPoints ?? [],
        actionItems: parsed?.actionItems ?? [],
        decisions: parsed?.decisions ?? [],
        model: model || null,
        botName,
      };
    },
    askInMeeting: async ({ appId, meetingId, question, transcript, botId }) => {
      const session = getOrCreateSession(appId, meetingId);
      const bot =
        (botId ? session.bots.find((b) => b.id === botId) : undefined) ??
        session.bots[0] ??
        BUILTIN_ASSISTANT;
      if (session.roomId && deps.postToRoom) {
        await deps.postToRoom({ roomId: session.roomId, text: question }).catch(() => undefined);
      }
      const context = formatMeetingContext(session, transcript);
      const system = `你是加入当前会议的 ${bot.name}（Moss 助手）。请基于会议记录和上下文直接回答参会者问题，语言清晰简洁。`;
      const { text, model } = await askAi(`${context}\n\n参会者提问：${question}`, system, false);
      return {
        meetingId,
        answer: text.trim(),
        model: model || null,
        botName: bot.name,
        roomId: session.roomId,
      };
    },
  };
}

export function makeMossbotCapability(deps: {
  readonly ai: PageAppAiGateway;
  readonly mossbot?: PageAppMossbotGateway | null;
}): PageAppServerCapability {
  const gateway = deps.mossbot ?? makeMossbotCapabilityGateway({ ai: deps.ai });

  return {
    name: "mossbot",
    consent: "standing",
    call: (ctx: PageAppServerCallContext, method: string, rawArgs: unknown) =>
      Effect.tryPromise({
        try: async () => {
          if (!ctx.viewer.isOwner) {
            throw fail("unavailable", "仅应用页所有者可使用 Moss 助手协同能力。");
          }
          const args = isRecord(rawArgs) ? rawArgs : {};
          switch (method) {
            case "listBots":
              return gateway.listBots();
            case "joinMeeting": {
              const meetingId =
                typeof args.meetingId === "string" && args.meetingId.trim()
                  ? args.meetingId.trim().slice(0, 128)
                  : `meeting-${ctx.app.id}`;
              const title =
                typeof args.title === "string" && args.title.trim()
                  ? args.title.trim().slice(0, 200)
                  : ctx.app.title;
              const topic =
                typeof args.topic === "string" && args.topic.trim()
                  ? args.topic.trim().slice(0, 500)
                  : undefined;
              const botId =
                typeof args.botId === "string" && args.botId.trim()
                  ? args.botId.trim().slice(0, 128)
                  : undefined;
              return gateway.joinMeeting({
                appId: ctx.app.id,
                meetingId,
                title,
                ...(topic ? { topic } : {}),
                ...(botId ? { botId } : {}),
              });
            }
            case "postNote": {
              const meetingId = typeof args.meetingId === "string" ? args.meetingId.trim() : "";
              const text = typeof args.text === "string" ? args.text.trim() : "";
              if (!meetingId) throw fail("invalid_argument", "postNote 需要提供 meetingId。");
              if (!text || text.length > PAGE_APP_MOSSBOT_MAX_NOTE_CHARS) {
                throw fail(
                  "invalid_argument",
                  `会议记录不能为空且不能超过 ${PAGE_APP_MOSSBOT_MAX_NOTE_CHARS} 字符。`,
                );
              }
              const kind =
                args.kind === "transcript" || args.kind === "decision" || args.kind === "action"
                  ? args.kind
                  : "note";
              const author =
                typeof args.author === "string" && args.author.trim()
                  ? args.author.trim().slice(0, 80)
                  : ctx.viewer.name;
              return gateway.postNote({ appId: ctx.app.id, meetingId, author, text, kind });
            }
            case "summarizeMeeting": {
              const meetingId = typeof args.meetingId === "string" ? args.meetingId.trim() : "";
              if (!meetingId)
                throw fail("invalid_argument", "summarizeMeeting 需要提供 meetingId。");
              const transcript =
                typeof args.transcript === "string"
                  ? args.transcript.slice(0, PAGE_APP_MOSSBOT_MAX_TRANSCRIPT_CHARS)
                  : undefined;
              return gateway.summarizeMeeting({
                appId: ctx.app.id,
                meetingId,
                ...(typeof args.prompt === "string" ? { prompt: args.prompt.slice(0, 4_000) } : {}),
                ...(transcript ? { transcript } : {}),
                ...(typeof args.focus === "string" ? { focus: args.focus.slice(0, 500) } : {}),
              });
            }
            case "askInMeeting": {
              const meetingId = typeof args.meetingId === "string" ? args.meetingId.trim() : "";
              const question = typeof args.question === "string" ? args.question.trim() : "";
              if (!meetingId || !question) {
                throw fail("invalid_argument", "askInMeeting 需要提供 meetingId 与 question。");
              }
              return gateway.askInMeeting({
                appId: ctx.app.id,
                meetingId,
                question: question.slice(0, 8_000),
                ...(typeof args.transcript === "string"
                  ? { transcript: args.transcript.slice(0, PAGE_APP_MOSSBOT_MAX_TRANSCRIPT_CHARS) }
                  : {}),
                ...(typeof args.botId === "string" && args.botId.trim()
                  ? { botId: args.botId.trim().slice(0, 128) }
                  : {}),
              });
            }
            default:
              throw fail("invalid_argument", `mossbot 不支持方法 "${method}"。`);
          }
        },
        catch: (error) => {
          const err = toPageAppCallError(error);
          return fail(err.code, err.message);
        },
      }),
  };
}
