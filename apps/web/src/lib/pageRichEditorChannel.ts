import { parsePageRichContent } from "@synara/shared/pageRichContent";

export interface PageRichEditorDocument {
  documentKey: string;
  richContent: string | null;
  content: string;
  readOnly: boolean;
  theme: "light" | "dark";
  fontSize?: number;
}
export interface PageRichEditorValue {
  richContent: string | null;
  content: string;
}
type Message = Record<string, unknown>;

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
  ) {}

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
      this.onUnavailable(false);
      this.onReady(false);
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
