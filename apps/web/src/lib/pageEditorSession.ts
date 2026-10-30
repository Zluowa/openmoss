import type { PagesMutateInput, PagesMutateResult, PagesReadResult } from "@synara/contracts";
import { WORKSPACE_EDITOR_AUTOSAVE_MS } from "./workspaceEditorSession";

type PageUpdate = Extract<PagesMutateInput, { op: "update" }>;
export interface PageEditorSnapshot {
  document: PagesReadResult;
  title: string;
  content: string;
  richContent: string | null;
  saving: boolean;
  error: string | null;
  version: number;
}

/** A Page keeps one CAS writer. Unknown results retry the same request, while
 * edits made during a write drain against the acknowledged revision. The
 * shared workspace editor supplies the editor and autosave cadence. */
export class PageEditorSession {
  private state: PageEditorSnapshot;
  private listeners = new Set<() => void>();
  private pending: PageUpdate | null = null;
  private writing: Promise<boolean> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private journalError: string | null = null;
  private recoveredConflict = false;
  private paused = false;

  constructor(
    initial: PagesReadResult,
    private readonly write: (input: PageUpdate) => Promise<PagesMutateResult>,
    private readonly onSaved: (document: PagesReadResult) => void,
    private readonly journal?: { read: () => string | null; write: (value: string | null) => void },
  ) {
    this.state = {
      document: initial,
      title: initial.page.title,
      content: initial.content,
      richContent: initial.richContent ?? null,
      saving: false,
      error: null,
      version: 0,
    };
    try {
      const raw = journal?.read();
      if (raw) {
        const draft: unknown = JSON.parse(raw);
        if (
          draft &&
          typeof draft === "object" &&
          "title" in draft &&
          "content" in draft &&
          "revision" in draft &&
          typeof draft.title === "string" &&
          typeof draft.content === "string" &&
          typeof draft.revision === "number" &&
          Number.isSafeInteger(draft.revision) &&
          draft.revision >= 1
        ) {
          // A newer server revision must not silently absorb a recovered draft.
          this.state = {
            ...this.state,
            title: draft.title,
            content: draft.content,
            richContent:
              "richContent" in draft && typeof draft.richContent === "string"
                ? draft.richContent
                : null,
            error:
              draft.revision === initial.page.revision
                ? null
                : "页面已有更新。你的未保存草稿已保留，请先比较后另存或重新载入。",
          };
          this.recoveredConflict = draft.revision !== initial.page.revision;
          if ("pending" in draft && draft.pending && typeof draft.pending === "object") {
            const pending = draft.pending as PageUpdate;
            if (
              pending.op === "update" &&
              pending.pageId === initial.page.id &&
              pending.scopeSpaceId === initial.page.scopeSpaceId &&
              typeof pending.requestId === "string" &&
              pending.expectedRevision === draft.revision &&
              typeof pending.title === "string" &&
              typeof pending.content === "string"
            )
              this.pending = pending;
          }
          if (this.pending) this.recoveredConflict = false;
        }
      }
    } catch {
      this.journalError = "本机草稿缓存暂不可用；关闭前请确认页面已保存。";
    }
  }

  getSnapshot = () => this.state;
  get dirty() {
    return (
      this.state.title !== this.state.document.page.title ||
      this.state.content !== this.state.document.content ||
      this.state.richContent !== (this.state.document.richContent ?? null) ||
      this.pending !== null
    );
  }
  get warning() {
    return this.journalError;
  }
  pause = () => {
    this.paused = true;
    clearTimeout(this.timer);
  };
  resume = () => {
    this.paused = false;
    this.schedule();
  };
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    this.schedule();
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) clearTimeout(this.timer);
    };
  };
  private publish(patch: Partial<PageEditorSnapshot>) {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
  private persist() {
    try {
      this.journal?.write(
        this.dirty
          ? JSON.stringify({
              revision: this.pending?.expectedRevision ?? this.state.document.page.revision,
              title: this.state.title,
              content: this.state.content,
              richContent: this.state.richContent,
              pending: this.pending,
            })
          : null,
      );
    } catch {
      this.journalError = "本机草稿缓存暂不可用；关闭前请确认页面已保存。";
    }
  }
  change = (patch: { title?: string; content?: string; richContent?: string | null }) => {
    this.publish({
      ...patch,
      ...(this.state.error === "请填写页面标题。" && (patch.title ?? this.state.title).trim()
        ? { error: null }
        : {}),
    });
    this.persist();
    this.schedule();
  };
  load = (document: PagesReadResult) => {
    if (this.writing || this.dirty || document.page.revision < this.state.document.page.revision)
      return;
    if (
      document.page.revision === this.state.document.page.revision &&
      document.content === this.state.content &&
      document.page.title === this.state.title &&
      (document.richContent ?? null) === this.state.richContent
    )
      return;
    this.publish({
      document,
      title: document.page.title,
      content: document.content,
      richContent: document.richContent ?? null,
      version:
        this.state.version +
        (document.content === this.state.content &&
        (document.richContent ?? null) === this.state.richContent
          ? 0
          : 1),
    });
  };
  private schedule() {
    clearTimeout(this.timer);
    if (this.paused || !this.dirty || this.writing || this.state.error || this.listeners.size === 0)
      return;
    this.timer = setTimeout(() => void this.flush(), WORKSPACE_EDITOR_AUTOSAVE_MS);
  }
  flush = (): Promise<boolean> => {
    clearTimeout(this.timer);
    if (this.writing) return this.writing;
    if (this.paused) return Promise.resolve(!this.dirty);
    if (!this.dirty) return Promise.resolve(true);
    if (this.recoveredConflict) return Promise.resolve(false);
    if (!this.state.title.trim()) {
      this.publish({ error: "请填写页面标题。" });
      return Promise.resolve(false);
    }
    this.writing = Promise.resolve()
      .then(async () => {
        this.publish({ saving: true, error: null });
        while (this.dirty) {
          const document = this.state.document;
          const sent = this.pending ?? {
            op: "update" as const,
            requestId: crypto.randomUUID(),
            scopeSpaceId: document.page.scopeSpaceId,
            pageId: document.page.id,
            expectedRevision: document.page.revision,
            title: this.state.title.trim(),
            content: this.state.content,
            richContent: this.state.richContent,
          };
          this.pending = sent;
          this.persist();
          try {
            const saved = await this.write(sent);
            if (saved.page.revision < this.state.document.page.revision) {
              this.pending = null;
              // The acknowledgement can predate a newer remote edit loaded after
              // restart. Retire only this request; do not rebase an unsent edit.
              if (
                this.state.title.trim() === sent.title &&
                this.state.content === sent.content &&
                this.state.richContent === (sent.richContent ?? null)
              ) {
                this.publish({
                  title: this.state.document.page.title,
                  content: this.state.document.content,
                  richContent: this.state.document.richContent ?? null,
                  version: this.state.version + 1,
                });
                this.persist();
                return true;
              }
              this.recoveredConflict = true;
              this.publish({ error: "页面已有更新。未发送的草稿已保留，请比较后另存或重新载入。" });
              this.persist();
              return false;
            }
            const title =
              this.state.title.trim() === sent.title ? saved.page.title : this.state.title;
            const bufferMatchesSent =
              this.state.content === sent.content &&
              this.state.richContent === (sent.richContent ?? null);
            this.pending = null;
            this.publish({
              document: saved,
              title,
              ...(bufferMatchesSent
                ? { content: saved.content, richContent: saved.richContent ?? null }
                : {}),
            });
            this.persist();
            this.onSaved(saved);
          } catch (error) {
            this.publish({
              error:
                error instanceof Error ? error.message : "无法确认保存。草稿已保留，请重试或另存。",
            });
            return false;
          }
        }
        return true;
      })
      .finally(() => {
        this.writing = null;
        this.publish({ saving: false });
      });
    return this.writing;
  };
  /** Explicit user-confirmed reload; never called by background query refresh. */
  discardAndLoad = (document: PagesReadResult) => {
    if (this.writing) return;
    this.pending = null;
    this.recoveredConflict = false;
    this.publish({
      document,
      title: document.page.title,
      content: document.content,
      richContent: document.richContent ?? null,
      error: null,
      version: this.state.version + 1,
    });
    this.persist();
  };
}
