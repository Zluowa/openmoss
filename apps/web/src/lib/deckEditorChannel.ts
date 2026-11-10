// FILE: deckEditorChannel.ts
// Purpose: The host side of the Moss Canvas deck editor protocol (slides/DECK-SCHEMA.md §4):
//          envelope checks, the actions Moss sends and the events it accepts, each validated.
// Layer: Web lib (used by DeckEditorHost)
// Why: The editor runs Moss Canvas code in another origin. The parent owns identity, revision
//      and storage; the child only edits a buffer, so every event is checked before Moss acts.

import { parseSlidesDeck, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";

type Message = Record<string, unknown>;

export interface DeckEditorDocument {
  documentKey: string;
  deck: SlidesDeck;
  title: string;
  readOnly: boolean;
  mode: "edit" | "view" | "present";
  startSlideId?: string;
  theme: "light" | "dark";
  locale: "zh-CN" | "en";
}

export interface DeckTarget {
  slideIds: string[];
  elementIds: string[];
}
export interface DeckEditorDraft {
  id: string;
  baseRevision: number;
  summary: string | null;
  ops: unknown[];
  status: "open" | "running";
  author: "agent" | "local-user";
  authorThreadId: string | null;
  agentLabel?: string;
  target?: DeckTarget;
}
export interface DeckEditorAiContext {
  aiAvailable: boolean;
  agentLabel: string | null;
  drafts: DeckEditorDraft[];
  running: { requestId: string; target: DeckTarget | null; instruction: string }[];
}

export interface DeckCommentAnchor {
  slideId: string;
  elementId?: string;
}
export interface DeckCommentMessage {
  id: string;
  kind: "person" | "agent";
  author: string;
  initials: string;
  body: string;
  createdAt: string;
  /** Agent replies: still working, answered, or finished without answering here. */
  status?: "thinking" | "done" | "failed";
  /** A person's message that went to the agent. */
  sentToAgent?: boolean;
}
/** One comment thread as the editor draws it (pin + card). */
export interface DeckCommentThread {
  id: string;
  anchor: DeckCommentAnchor;
  label: string;
  count: number;
  resolved: boolean;
  working: boolean;
  messages: DeckCommentMessage[];
}

export interface DeckViewContext {
  mode: "edit" | "overview" | "grid" | "present";
  slideId: string | null;
  slideIndex: number;
  slideCount: number;
  slideTitle?: string;
  selected: string[];
  selection: { id: string; kind: string; label?: string }[];
}

export type DeckEditorEvent =
  | { event: "change"; deck: SlidesDeck; title?: string }
  | {
      event: "ai-request";
      requestId: string;
      instruction: string;
      mode: "change" | "ask";
      target: DeckTarget;
      origin: "toolbar" | "inline" | "composer" | "comment" | "chip";
    }
  | { event: "drafts-resolved"; draftIds: string[]; action: "accept" | "discard"; failed: string[] }
  | {
      event: "request-image";
      requestId: string;
      mode: "upload" | "generate" | "space";
      prompt?: string;
      target: { slideId: string; elementId?: string };
      /** Pasted, dropped or picked in the editor: the file itself. */
      file?: { name: string; type: string; data: ArrayBuffer };
    }
  | {
      event: "request-export";
      format: "pptx" | "pdf" | "png";
      /** 范围: the slides to export; all when absent. */
      slideIds?: string[];
      /** 包含备注: PDF gets a notes page per slide, PPTX keeps notes either way. */
      includeNotes?: boolean;
    }
  | {
      event: "request-present";
      startSlideId: string | null;
      surface: "fullscreen" | "presenter" | "window";
    }
  | { event: "request-share" }
  | { event: "request-history" }
  | { event: "request-comments"; anchor: unknown }
  | {
      event: "comment-post";
      anchor: DeckCommentAnchor;
      label: string;
      body: string;
      sendToAgent: boolean;
    }
  | { event: "comment-reply"; threadId: string; body: string; sendToAgent: boolean }
  | { event: "comment-resolve"; threadId: string; resolved: boolean }
  | { event: "comment-delete"; threadId: string }
  | { event: "title-change"; title: string }
  | { event: "thumbnail"; slideId: string; png: string }
  | { event: "view-context"; context: DeckViewContext }
  | { event: "stop-ai"; requestId: string | null }
  | { event: "error"; message: string };

const short = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const idList = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) && value.length <= max && value.every((id) => short(id, 128));
const target = (value: unknown): DeckTarget | null => {
  if (!value || typeof value !== "object") return { slideIds: [], elementIds: [] };
  const raw = value as Message;
  const slideIds = raw.slideIds ?? [];
  const elementIds = raw.elementIds ?? [];
  return idList(slideIds, 300) && idList(elementIds, 500) ? { slideIds, elementIds } : null;
};

/** Checks an editor event; returns null for anything Moss should ignore. */
export function parseDeckEditorEvent(value: Message): DeckEditorEvent | null {
  switch (value.event) {
    case "change": {
      try {
        const deck = parseSlidesDeck(value.deck);
        return {
          event: "change",
          deck,
          ...(short(value.title, 256) && value.title.trim() ? { title: value.title } : {}),
        };
      } catch {
        return null;
      }
    }
    case "ai-request": {
      const t = target(value.target);
      return short(value.requestId, 128) &&
        short(value.instruction, 20_000) &&
        value.instruction.trim() &&
        t
        ? {
            event: "ai-request",
            requestId: value.requestId,
            instruction: value.instruction,
            mode: value.mode === "ask" ? "ask" : "change",
            target: t,
            origin: (["toolbar", "inline", "composer", "comment", "chip"] as const).includes(
              value.origin as never,
            )
              ? (value.origin as "toolbar")
              : "inline",
          }
        : null;
    }
    case "drafts-resolved":
      return (value.action === "accept" || value.action === "discard") &&
        idList(value.draftIds, 256) &&
        value.draftIds.length > 0
        ? {
            event: "drafts-resolved",
            draftIds: value.draftIds,
            action: value.action,
            failed: idList(value.failed, 256) ? value.failed : [],
          }
        : null;
    case "request-image": {
      const raw = (value.target ?? {}) as Message;
      const file = value.file as Message | undefined;
      const validFile =
        file === undefined ||
        (short(file.name, 256) &&
          short(file.type, 128) &&
          String(file.type).startsWith("image/") &&
          file.data instanceof ArrayBuffer &&
          file.data.byteLength <= 25 * 1024 * 1024);
      return short(value.requestId, 128) &&
        (value.mode === "upload" || value.mode === "generate" || value.mode === "space") &&
        validFile &&
        short(raw.slideId, 128) &&
        (raw.elementId === undefined || short(raw.elementId, 128)) &&
        (value.prompt === undefined || short(value.prompt, 4_000))
        ? {
            event: "request-image",
            requestId: value.requestId,
            mode: value.mode,
            ...(value.prompt ? { prompt: value.prompt as string } : {}),
            ...(file && validFile
              ? {
                  file: {
                    name: file.name as string,
                    type: file.type as string,
                    data: file.data as ArrayBuffer,
                  },
                }
              : {}),
            target: {
              slideId: raw.slideId as string,
              ...(raw.elementId ? { elementId: raw.elementId as string } : {}),
            },
          }
        : null;
    }
    case "request-export":
      return ["pptx", "pdf", "png"].includes(String(value.format)) &&
        (value.slideIds === undefined || idList(value.slideIds, 300))
        ? {
            event: "request-export",
            format: value.format as "pptx",
            ...(value.slideIds ? { slideIds: value.slideIds as string[] } : {}),
            ...(value.includeNotes === true ? { includeNotes: true } : {}),
          }
        : null;
    case "request-present":
      return {
        event: "request-present",
        startSlideId: short(value.startSlideId, 128) ? value.startSlideId : null,
        surface:
          value.surface === "presenter" || value.surface === "window" ? "presenter" : "fullscreen",
      };
    case "request-share":
      return { event: "request-share" };
    case "request-history":
      return { event: "request-history" };
    case "request-comments":
      return { event: "request-comments", anchor: value.anchor ?? null };
    case "comment-post": {
      const raw = (value.anchor ?? {}) as Message;
      return short(raw.slideId, 128) &&
        (raw.elementId === undefined || short(raw.elementId, 128)) &&
        short(value.body, 4_000) &&
        value.body.trim()
        ? {
            event: "comment-post",
            anchor: {
              slideId: raw.slideId,
              ...(raw.elementId ? { elementId: raw.elementId as string } : {}),
            },
            label: short(value.label, 120) ? value.label : "",
            body: value.body.trim(),
            sendToAgent: value.sendToAgent === true,
          }
        : null;
    }
    case "comment-reply":
      return short(value.threadId, 128) && short(value.body, 4_000) && value.body.trim()
        ? {
            event: "comment-reply",
            threadId: value.threadId,
            body: value.body.trim(),
            sendToAgent: value.sendToAgent === true,
          }
        : null;
    case "comment-resolve":
      return short(value.threadId, 128)
        ? { event: "comment-resolve", threadId: value.threadId, resolved: value.resolved !== false }
        : null;
    case "comment-delete":
      return short(value.threadId, 128)
        ? { event: "comment-delete", threadId: value.threadId }
        : null;
    case "title-change":
      return short(value.title, 256) && value.title.trim()
        ? { event: "title-change", title: value.title }
        : null;
    case "thumbnail":
      return short(value.slideId, 128) &&
        short(value.png, 600_000) &&
        value.png.startsWith("data:image/png;base64,")
        ? { event: "thumbnail", slideId: value.slideId, png: value.png }
        : null;
    case "view-context": {
      const raw = (value.context ?? value) as Message;
      if (!["edit", "overview", "grid", "present"].includes(String(raw.mode))) return null;
      const selection = Array.isArray(raw.selection) ? raw.selection.slice(0, 5) : [];
      return {
        event: "view-context",
        context: {
          mode: raw.mode as DeckViewContext["mode"],
          slideId: short(raw.slideId, 128) ? raw.slideId : null,
          slideIndex: Number.isInteger(raw.slideIndex) ? (raw.slideIndex as number) : 0,
          slideCount: Number.isInteger(raw.slideCount) ? (raw.slideCount as number) : 0,
          ...(short(raw.slideTitle, 200) ? { slideTitle: raw.slideTitle } : {}),
          selected: idList(raw.selected, 20) ? raw.selected : [],
          selection: selection
            .filter((item): item is Message => !!item && typeof item === "object")
            .filter((item) => short(item.id, 128) && short(item.kind, 20))
            .map((item) => ({
              id: item.id as string,
              kind: item.kind as string,
              ...(short(item.label, 60) ? { label: item.label as string } : {}),
            })),
        },
      };
    }
    case "stop-ai":
    case "cancel-ai":
      return { event: "stop-ai", requestId: short(value.requestId, 128) ? value.requestId : null };
    case "error":
      return {
        event: "error",
        message: short(value.message, 2_000) ? value.message : "编辑器出错",
      };
    default:
      return null;
  }
}

export const DECK_EDITOR_REQUIRED = ["deck-v2", "flush"] as const;

export class DeckEditorChannel {
  private seq = 0;
  private childSeq = 0;
  private ready = false;
  private loaded = false;
  private disposed = false;
  private document: DeckEditorDocument | null = null;
  private aiContext: DeckEditorAiContext | null = null;
  private comments: DeckCommentThread[] | null = null;
  private documentSeq = 0;
  private flushWaiters = new Map<number, (ok: boolean) => void>();
  capabilities: readonly string[] = [];
  onEvent: (event: DeckEditorEvent) => void = () => {};

  constructor(
    readonly nonce: string,
    private readonly send: (message: Message) => void,
    private readonly onReady: (ready: boolean) => void,
    private readonly onError: (message: string) => void,
  ) {}

  get isLoaded() {
    return this.ready && this.loaded;
  }
  supports(capability: string) {
    return this.capabilities.includes(capability);
  }

  private post(action: string, fields: Message = {}) {
    const seq = ++this.seq;
    this.send({
      type: "moss-deck-editor",
      version: 1,
      sessionNonce: this.nonce,
      seq,
      action,
      ...fields,
    });
    return seq;
  }
  hello = () => {
    if (!this.disposed) this.post("hello");
  };
  load = (document: DeckEditorDocument) => {
    this.document = document;
    if (this.ready && !this.disposed) {
      this.loaded = false;
      this.onReady(false);
      this.documentSeq = this.post("load", { ...document });
    }
  };
  setReadOnly = (readOnly: boolean) => {
    if (this.document) this.document = { ...this.document, readOnly };
    if (this.ready && !this.disposed) this.post("set-read-only", { readOnly });
  };
  setPresentation = (theme: "light" | "dark") => {
    if (this.document) this.document = { ...this.document, theme };
    if (this.ready && !this.disposed) this.post("set-presentation", { theme });
  };
  setAiContext = (context: DeckEditorAiContext) => {
    this.aiContext = context;
    if (this.isLoaded && !this.disposed) this.post("set-ai-context", { context });
  };
  resolveDrafts = (draftIds: string[] | "all", resolution: "accept" | "discard") => {
    if (this.isLoaded && !this.disposed) this.post("resolve-drafts", { draftIds, resolution });
  };
  imageResult = (result: {
    requestId: string;
    ok: boolean;
    src?: string;
    alt?: string;
    error?: string;
    candidates?: string[];
  }) => {
    if (this.isLoaded && !this.disposed) this.post("image-result", result);
  };
  applyOps = (ops: unknown[]) => {
    if (this.isLoaded && !this.disposed) this.post("apply-ops", { ops });
  };
  setComments = (threads: DeckCommentThread[]) => {
    this.comments = threads;
    if (this.isLoaded && !this.disposed) this.post("set-comments", { threads });
  };
  /** 正在保存 / 保存失败 in the editor's title pill. */
  saveStatus = (status: "saved" | "error", message?: string) => {
    if (this.isLoaded && !this.disposed)
      this.post("save-status", { status, ...(message ? { message } : {}) });
  };
  /** Asks the editor to send its last change; resolves false if it does not answer in time. */
  flush = (timeoutMs = 2_000): Promise<boolean> => {
    if (!this.isLoaded || this.disposed) return Promise.resolve(true);
    const seq = this.post("flush");
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.flushWaiters.delete(seq);
        resolve(false);
      }, timeoutMs);
      this.flushWaiters.set(seq, (ok) => {
        clearTimeout(timer);
        resolve(ok);
      });
    });
  };
  reset = () => {
    this.ready = false;
    this.loaded = false;
    this.childSeq = 0;
    for (const resolve of this.flushWaiters.values()) resolve(false);
    this.flushWaiters.clear();
    this.onReady(false);
  };
  dispose = () => {
    this.reset();
    this.disposed = true;
  };

  receive = (input: unknown): boolean => {
    if (this.disposed || !input || typeof input !== "object" || Array.isArray(input)) return false;
    const value = input as Message;
    if (
      value.type !== "moss-deck-editor" ||
      value.version !== 1 ||
      value.sessionNonce !== this.nonce ||
      !Number.isSafeInteger(value.seq) ||
      (value.seq as number) <= this.childSeq
    )
      return false;
    this.childSeq = value.seq as number;
    if (value.event === "ready") {
      const capabilities = Array.isArray(value.capabilities)
        ? value.capabilities.filter((item): item is string => typeof item === "string")
        : [];
      if (!DECK_EDITOR_REQUIRED.every((capability) => capabilities.includes(capability))) {
        this.onError("当前 Canvas 版本不支持幻灯片编辑，请更新后重试。");
        return false;
      }
      this.capabilities = capabilities;
      this.ready = true;
      this.loaded = false;
      if (this.document) this.documentSeq = this.post("load", { ...this.document });
      return true;
    }
    if (value.event === "loaded") {
      if (value.documentSeq !== this.documentSeq) return false;
      this.loaded = true;
      this.onReady(true);
      if (this.aiContext) this.post("set-ai-context", { context: this.aiContext });
      if (this.comments) this.post("set-comments", { threads: this.comments });
      return true;
    }
    if (value.event === "flushed") {
      // The editor's last state rides along; take it like a change before settling.
      if (value.deck !== undefined && this.ready && !this.document?.readOnly) {
        const change = parseDeckEditorEvent({ event: "change", deck: value.deck });
        if (change) this.onEvent(change);
      }
      const waiter =
        this.flushWaiters.get(value.replyTo as number) ??
        this.flushWaiters.get(value.flushSeq as number);
      // Older editors answer without naming the request: settle every waiter.
      if (waiter) waiter(true);
      else for (const resolve of this.flushWaiters.values()) resolve(true);
      this.flushWaiters.clear();
      return true;
    }
    if (!this.ready) return false;
    const event = parseDeckEditorEvent(value);
    if (!event) return false;
    // A read-only deck accepts only what does not write.
    if (
      this.document?.readOnly &&
      ["change", "ai-request", "drafts-resolved", "request-image", "title-change"].includes(
        event.event,
      )
    )
      return false;
    this.onEvent(event);
    return true;
  };
}
