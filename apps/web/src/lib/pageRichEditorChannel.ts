import { PAGE_COVER_IDS, type PageCover } from "@moss/contracts";
import { parsePageRichContent } from "@moss/shared/pageRichContent";

export interface PageRichEditorDocument {
  documentKey: string;
  richContent: string | null;
  content: string;
  readOnly: boolean;
  theme: "light" | "dark";
  fontSize?: number;
  /** The Page's live room, relayed by the parent; the editor holds the Yjs replica. */
  collab?: PageRichEditorCollab;
}
export interface PageRichEditorCollab {
  pageId: string;
  generation: string | null;
  mode: "edit" | "view";
  user: { id: string; name: string; color: string };
}
/** Live-room traffic from the editor for the current document. */
export interface PageRichEditorCollabEvents {
  frame: (data: ArrayBuffer | string) => void;
  presence: (value: unknown) => void;
  reset: (generation: string | null) => void;
  retry: () => void;
  copy: (richContent: string) => void;
}
export interface PageRichEditorValue {
  richContent: string | null;
  content: string;
}
type Message = Record<string, unknown>;

/** What the page editor tells Moss about AI: a request to run, a draft decision, a link. */
export type PageEditorAiEvent =
  | {
      event: "ai-request";
      mode: "generate" | "visualize" | "image" | "prompt";
      prompt: string;
      anchorBlockId: string | null;
    }
  | { event: "drafts-resolved"; draftIds: string[]; action: "accept" | "discard" }
  | { event: "open-ref"; kind: "page" | "file" | "chat" | "thread" | "app-page"; id: string }
  | { event: "request-subpage" }
  | { event: "request-upload"; kind: "image" | "file"; anchorBlockId: string | null }
  | { event: "ai-input-changed"; mode: "generate" | "visualize" | "image" | null };
export interface PageEditorAiContext {
  locale: "zh-CN" | "en";
  aiAvailable: boolean;
  agentLabel: string | null;
  drafts: unknown[];
  threads: Record<string, string>;
  refs: {
    pages: { id: string; title: string }[];
    files: { id: string; title: string }[];
    chats: { id: string; title: string }[];
  };
}

/** The page header the editor draws above the body (title, crumbs, links), so they scroll as one. */
export interface PageRichEditorHeaderLink {
  id: string;
  label: string;
}
export interface PageRichEditorHeader {
  title: string;
  placeholder: string;
  editable: boolean;
  crumbs: PageRichEditorHeaderLink[];
  links: PageRichEditorHeaderLink[];
  /** A Central glyph name or one emoji; null = none. */
  icon: string | null;
  cover: PageCover | null;
}
/** A header edit carries only the fields that changed. */
export type PageEditorHeaderEvent =
  | { event: "header-change"; title?: string; icon?: string | null; cover?: PageCover | null }
  | { event: "header-action"; id: string };
const pageIcon = (value: unknown): value is string | null =>
  value === null ||
  (typeof value === "string" && value.trim() === value && value !== "" && value.length <= 32);
const pageCover = (value: unknown): value is PageCover | null =>
  value === null || (PAGE_COVER_IDS as readonly unknown[]).includes(value);

const shortString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length <= max;
const nullableId = (value: unknown) => value === null || shortString(value, 256);
/** The editor runs Moss Canvas code; the host still checks every AI event it acts on. */
export function parsePageEditorAiEvent(value: Message): PageEditorAiEvent | null {
  switch (value.event) {
    case "ai-request":
      return ["generate", "visualize", "image", "prompt"].includes(String(value.mode)) &&
        shortString(value.prompt, 20_000) &&
        value.prompt.trim() !== "" &&
        nullableId(value.anchorBlockId)
        ? (value as unknown as PageEditorAiEvent)
        : null;
    case "drafts-resolved":
      return (value.action === "accept" || value.action === "discard") &&
        Array.isArray(value.draftIds) &&
        value.draftIds.length > 0 &&
        value.draftIds.length <= 256 &&
        value.draftIds.every((id) => shortString(id, 256))
        ? (value as unknown as PageEditorAiEvent)
        : null;
    case "open-ref":
      return ["page", "file", "chat", "thread", "app-page"].includes(String(value.kind)) &&
        shortString(value.id, 256) &&
        value.id !== ""
        ? (value as unknown as PageEditorAiEvent)
        : null;
    case "request-subpage":
      return { event: "request-subpage" };
    case "ai-input-changed":
      return value.mode === null || ["generate", "visualize", "image"].includes(String(value.mode))
        ? (value as unknown as PageEditorAiEvent)
        : null;
    case "request-upload":
      return (value.kind === "image" || value.kind === "file") && nullableId(value.anchorBlockId)
        ? (value as unknown as PageEditorAiEvent)
        : null;
    default:
      return null;
  }
}

/** Header edits and clicks from the editor; the host still checks what it acts on. */
export function parsePageEditorHeaderEvent(value: Message): PageEditorHeaderEvent | null {
  if (value.event === "header-change") {
    const change: {
      event: "header-change";
      title?: string;
      icon?: string | null;
      cover?: PageCover | null;
    } = { event: "header-change" };
    if (value.title !== undefined) {
      if (!shortString(value.title, 256)) return null;
      change.title = value.title;
    }
    if (value.icon !== undefined) {
      if (!pageIcon(value.icon)) return null;
      change.icon = value.icon;
    }
    if (value.cover !== undefined) {
      if (!pageCover(value.cover)) return null;
      change.cover = value.cover;
    }
    return Object.keys(change).length > 1 ? change : null;
  }
  if (value.event === "header-action" && shortString(value.id, 256) && value.id !== "")
    return { event: "header-action", id: value.id };
  return null;
}

/** The parent owns identity, revision and storage. This channel carries a
 * controlled editor buffer only; a child cannot select a Page or write it. */
export class PageRichEditorChannel {
  private seq = 0;
  private childSeq = 0;
  private documentSeq = 0;
  private ready = false;
  private loaded = false;
  private disposed = false;
  private document: PageRichEditorDocument | null = null;
  private capabilities: readonly unknown[] = [];
  private aiContext: PageEditorAiContext | null = null;
  /** The loaded editor speaks the page AI protocol (drafts, slash AI items). */
  aiSupported = false;
  onAiEvent: (event: PageEditorAiEvent) => void = () => {};
  private header: PageRichEditorHeader | null = null;
  /** The loaded editor draws the page header itself (title and body scroll as one page). */
  headerSupported = false;
  onHeaderSupportChange: (supported: boolean) => void = () => {};
  onHeaderEvent: (event: PageEditorHeaderEvent) => void = () => {};
  private pending = new Map<
    number,
    { resolve: (ok: boolean) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    readonly nonce: string,
    private readonly send: (message: Message) => void,
    private readonly onChange: (value: PageRichEditorValue) => void,
    private readonly onReady: (ready: boolean) => void,
    private readonly onError: (message: string) => void,
    private readonly onUnavailable: (unavailable: boolean) => void = () => {},
    private readonly collab: Partial<PageRichEditorCollabEvents> = {},
  ) {}

  /** The loaded editor can hold a live replica (older Canvas bundles cannot). */
  get supportsRealtime() {
    return this.capabilities.includes("realtime");
  }
  get isLoaded() {
    return this.ready && this.loaded;
  }
  collabFrame = (data: ArrayBuffer | string) => {
    if (
      this.ready &&
      this.loaded &&
      !this.disposed &&
      this.document?.collab &&
      this.supportsRealtime
    )
      this.post("collab-frame", { data });
  };
  collabStatus = (status: "connecting" | "online" | "offline" | "rejected", reason?: string) => {
    if (
      this.ready &&
      this.loaded &&
      !this.disposed &&
      this.document?.collab &&
      this.supportsRealtime
    )
      this.post("collab-status", { status, ...(reason ? { reason: reason.slice(0, 300) } : {}) });
  };

  private post(action: string, fields: Message = {}) {
    const seq = ++this.seq;
    this.send({
      type: "moss-page-editor",
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
  load = (document: PageRichEditorDocument) => {
    this.onUnavailable(false);
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
  setPresentation = (presentation: Pick<PageRichEditorDocument, "theme" | "fontSize">) => {
    if (this.document) this.document = { ...this.document, ...presentation };
    if (this.ready && !this.disposed) this.post("set-presentation", presentation);
  };
  /** Drafts, reference lists and language for the editor's AI features; resent after each load. */
  setAiContext = (context: PageEditorAiContext) => {
    this.aiContext = context;
    if (this.ready && this.aiSupported && !this.disposed) this.post("set-ai-context", { context });
  };
  setHeader = (header: PageRichEditorHeader) => {
    this.header = header;
    if (this.ready && this.headerSupported && !this.disposed) this.post("set-header", { header });
  };
  resolveDrafts = (draftIds: string[] | "all", resolution: "accept" | "discard") => {
    if (this.ready && this.loaded && this.aiSupported && !this.disposed)
      this.post("resolve-drafts", { draftIds, resolution });
  };
  openAiInput = (mode: "generate" | "visualize" | "image" | "insert") => {
    if (this.ready && this.loaded && this.aiSupported && !this.disposed)
      this.post("open-ai-input", { mode });
  };
  /** Runs one page insert-menu item at the cursor (the top bar's ＋ menu). */
  runInsertItem = (value: string) => {
    if (this.ready && this.loaded && this.aiSupported && !this.disposed)
      this.post("run-insert-item", { value });
  };
  insertMedia = (media: {
    kind: "image" | "file";
    url: string;
    name: string;
    anchorBlockId: string | null;
  }) => {
    if (this.ready && this.loaded && this.aiSupported && !this.disposed)
      this.post("insert-media", media);
  };
  reset = () => {
    this.onUnavailable(false);
    this.ready = false;
    this.loaded = false;
    this.childSeq = 0;
    this.documentSeq = 0;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.resolve(false);
    }
    this.pending.clear();
    this.onReady(false);
  };
  connectionTimedOut = () => {
    if (this.loaded || this.disposed) return;
    this.onUnavailable(true);
    this.onError("页面编辑器尚未连接，可切换到 Markdown 编辑。已保存内容仍然保留。");
  };
  dispose = () => {
    this.reset();
    this.disposed = true;
  };
  receive = (input: unknown): boolean => {
    if (this.disposed || !input || typeof input !== "object" || Array.isArray(input)) return false;
    const value = input as Message;
    if (
      value.type !== "moss-page-editor" ||
      value.version !== 1 ||
      value.sessionNonce !== this.nonce ||
      !Number.isSafeInteger(value.seq) ||
      (value.seq as number) <= this.childSeq
    )
      return false;
    if (value.event === "ready") {
      if (
        !Array.isArray(value.capabilities) ||
        !["rich-content", "flush", "markdown-import"].every((capability) =>
          (value.capabilities as unknown[]).includes(capability),
        )
      ) {
        this.onError("当前 Canvas 编辑器版本不支持页面保存，请更新后重试。");
        return false;
      }
      this.childSeq = value.seq as number;
      this.ready = true;
      this.loaded = false;
      this.capabilities = value.capabilities as unknown[];
      this.aiSupported = (value.capabilities as unknown[]).includes("ai-drafts");
      const headerSupported = (value.capabilities as unknown[]).includes("page-header");
      if (headerSupported !== this.headerSupported) {
        this.headerSupported = headerSupported;
        this.onHeaderSupportChange(headerSupported);
      }
      if (this.header && this.headerSupported) this.post("set-header", { header: this.header });
      this.onUnavailable(false);
      this.onReady(false);
      if (this.aiContext && this.aiSupported)
        this.post("set-ai-context", { context: this.aiContext });
      if (this.document) this.documentSeq = this.post("load", { ...this.document });
      return true;
    }
    if (value.event === "loaded") {
      if (
        !this.ready ||
        !this.document ||
        value.documentKey !== this.document.documentKey ||
        value.documentSeq !== this.documentSeq ||
        value.replyTo !== this.documentSeq
      )
        return false;
      this.childSeq = value.seq as number;
      this.loaded = true;
      this.onUnavailable(false);
      this.onReady(true);
      return true;
    }
    if (value.event === "error") {
      if (
        typeof value.message !== "string" ||
        !this.ready ||
        !this.document ||
        value.documentKey !== this.document.documentKey ||
        value.documentSeq !== this.documentSeq ||
        (value.replyTo !== undefined &&
          (typeof value.replyTo !== "number" ||
            (value.replyTo !== this.documentSeq && !this.pending.has(value.replyTo))))
      )
        return false;
      this.childSeq = value.seq as number;
      this.onError(value.message.slice(0, 1000));
      if (
        !this.loaded &&
        this.ready &&
        this.document &&
        this.documentSeq > 0 &&
        value.documentKey === this.document.documentKey &&
        value.documentSeq === this.documentSeq &&
        value.replyTo === this.documentSeq
      ) {
        this.onUnavailable(true);
      }
      if (typeof value.replyTo === "number") this.finish(value.replyTo, false);
      return true;
    }
    if (
      typeof value.event === "string" &&
      value.event.startsWith("collab-") &&
      this.ready &&
      this.loaded &&
      this.document?.collab &&
      value.documentKey === this.document.documentKey &&
      value.documentSeq === this.documentSeq
    ) {
      this.childSeq = value.seq as number;
      return this.receiveCollab(value);
    }
    if (
      this.ready &&
      this.loaded &&
      this.headerSupported &&
      this.document &&
      value.documentKey === this.document.documentKey &&
      value.documentSeq === this.documentSeq
    ) {
      const headerEvent = parsePageEditorHeaderEvent(value);
      if (headerEvent) {
        this.childSeq = value.seq as number;
        if (!this.document.readOnly || headerEvent.event === "header-action")
          this.onHeaderEvent(headerEvent);
        return true;
      }
    }
    if (
      this.ready &&
      this.loaded &&
      this.aiSupported &&
      this.document &&
      value.documentKey === this.document.documentKey &&
      value.documentSeq === this.documentSeq
    ) {
      const aiEvent = parsePageEditorAiEvent(value);
      if (aiEvent) {
        this.childSeq = value.seq as number;
        if (!this.document.readOnly || aiEvent.event === "open-ref") this.onAiEvent(aiEvent);
        return true;
      }
    }
    if (
      !this.ready ||
      !this.loaded ||
      !this.document ||
      value.documentKey !== this.document.documentKey ||
      value.documentSeq !== this.documentSeq ||
      (value.event !== "change" && value.event !== "flushed") ||
      typeof value.richContent !== "string" ||
      (value.unchanged !== undefined && typeof value.unchanged !== "boolean")
    )
      return false;
    if (
      value.event === "flushed" &&
      (typeof value.replyTo !== "number" || !this.pending.has(value.replyTo))
    )
      return false;
    let parsed: PageRichEditorValue;
    try {
      parsed = parsePageRichContent(value.richContent);
    } catch {
      this.onError("页面编辑器返回的文档格式无效，已保留原内容。");
      if (typeof value.replyTo === "number") this.finish(value.replyTo, false);
      return false;
    }
    this.childSeq = value.seq as number;
    if (!this.document.readOnly)
      this.onChange(
        value.unchanged === true
          ? { content: this.document.content, richContent: this.document.richContent }
          : { content: parsed.content, richContent: parsed.richContent },
      );
    if (value.event === "flushed") this.finish(value.replyTo as number, true);
    return true;
  };
  private receiveCollab(value: Message): boolean {
    if (value.event === "collab-frame") {
      const data = value.data;
      if (data instanceof Uint8Array) this.collab.frame?.(data.slice().buffer as ArrayBuffer);
      else if (data instanceof ArrayBuffer || typeof data === "string") this.collab.frame?.(data);
      else return false;
    } else if (value.event === "collab-presence") this.collab.presence?.(value);
    else if (value.event === "collab-reset")
      this.collab.reset?.(typeof value.generation === "string" ? value.generation : null);
    else if (value.event === "collab-retry") this.collab.retry?.();
    else if (value.event === "collab-copy" && typeof value.richContent === "string")
      this.collab.copy?.(value.richContent);
    else return false;
    return true;
  }
  private finish(seq: number, ok: boolean) {
    const entry = this.pending.get(seq);
    if (!entry) return;
    this.pending.delete(seq);
    clearTimeout(entry.timer);
    entry.resolve(ok);
  }
  flush = (): Promise<boolean> => {
    if (this.disposed) return Promise.resolve(false);
    if (!this.ready || !this.loaded) return Promise.resolve(false);
    return new Promise((resolve) => {
      const seq = this.seq + 1;
      const timer = setTimeout(() => {
        this.onError("无法确认编辑器的最新内容，页面已保留，请重试保存。");
        this.finish(seq, false);
      }, 5_000);
      this.pending.set(seq, { resolve, timer });
      this.post("flush");
    });
  };
}
