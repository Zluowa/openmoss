// FILE: PageGuestApp.tsx
// Purpose: The guest view of a shared 资料空间 page, space or 站点: read-only page, page list
//          for shared spaces, comments when the role allows, and the access request flow for
//          invited-only links.
// Layer: Guest page (page links and sites), served by the share relay at `/p/<id>`

import type {
  PageGuestAppReference,
  PageGuestComment,
  PageGuestView,
  PageId,
  PageShareRole,
} from "@moss/contracts";
import { lazy, Suspense, useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { MossLogoMark } from "~/components/MossLogoMark";
import { CHAT_BACKGROUND_CLASS_NAME } from "~/components/chat/composerPickerStyles";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/input";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import { GuestNotice } from "../components/GuestNotice";
import { GuestAppItemPreview } from "./GuestAppItemPreview";
import { GuestDeckView } from "./GuestDeckView";
import { pageGuestCopy, type PageGuestCopy } from "./pageGuestCopy";
import type { PageGuestFailure, PageGuestTransport } from "./pageGuestTransport";
import {
  forgetPageKey,
  pageVisitorId,
  rememberGuestName,
  rememberPageKey,
  rememberedGuestName,
  type PageGuestEntry,
} from "./pageGuestUrl";
import { PageRichView } from "./PageRichView";

/** While the owner is offline the page tries again on its own. */
const OFFLINE_RETRY_MS = 15_000;
const REQUEST_POLL_MS = 10_000;
const GuestProjectionEditor = lazy<(typeof import("./GuestProjectionEditor"))["default"]>(
  async () => {
    try {
      return await import("./GuestProjectionEditor");
    } catch {
      return {
        default: (props: { words: PageGuestCopy["editor"]; finish: (saved: boolean) => void }) => (
          <section className="space-y-2">
            <p role="status">{props.words.unavailable}</p>
            <Button size="sm" variant="outline" onClick={() => props.finish(false)}>
              {props.words.close}
            </Button>
          </section>
        ),
      };
    }
  },
);
const REQUEST_SLOT = (entry: PageGuestEntry) => `moss-page:request:${entry.shareId}:${entry.link}`;

type Stage =
  | { readonly kind: "loading" }
  | { readonly kind: "ready"; readonly view: PageGuestView }
  | { readonly kind: "failed"; readonly failure: PageGuestFailure };

export function PageGuestApp(props: {
  readonly entry: PageGuestEntry | null;
  readonly transport: PageGuestTransport | null;
}) {
  const { locale } = useTranslation();
  const copy = pageGuestCopy(locale);
  const [entry, setEntry] = useState(props.entry);
  const [stage, setStage] = useState<Stage>({ kind: "loading" });
  const [pageId, setPageId] = useState<PageId | undefined>(undefined);
  const [visitor] = useState(() => pageVisitorId());
  const transport = props.transport;
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (entry === null || transport === null) return;
    const generation = ++loadGeneration.current;
    const result = await transport.view({
      visitor,
      ...(entry.link === null ? {} : { link: entry.link }),
      ...(entry.key === null ? {} : { key: entry.key }),
      ...(pageId === undefined ? {} : { pageId }),
    });
    if (generation !== loadGeneration.current) return;
    if (result.ok) {
      setStage({ kind: "ready", view: result.value });
      document.title = `${result.value.page.title || copy.untitled} · Moss`;
    } else {
      if (result.failure.kind === "refused" && result.failure.reason === "unavailable") {
        forgetPageKey(entry);
      }
      setStage({ kind: "failed", failure: result.failure });
    }
  }, [entry, transport, visitor, pageId, copy.untitled]);

  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current += 1;
    };
  }, [load]);

  // An offline owner or a dropped network comes back without the guest doing anything.
  useEffect(() => {
    if (stage.kind !== "failed" || stage.failure.kind === "refused") return;
    const timer = window.setTimeout(() => void load(), OFFLINE_RETRY_MS);
    return () => window.clearTimeout(timer);
  }, [stage, load]);

  if (entry === null || transport === null) {
    return <GuestNotice title={copy.notLink} detail={copy.notLinkDetail} />;
  }
  if (stage.kind === "loading") return <GuestNotice title={copy.loading} busy />;
  if (stage.kind === "failed") {
    const { failure } = stage;
    if (failure.kind === "refused" && failure.reason === "invite-only" && entry.link !== null) {
      return (
        <AccessRequest
          copy={copy}
          entry={entry}
          transport={transport}
          visitor={visitor}
          onApproved={(key) => {
            rememberPageKey({ shareId: entry.shareId, link: null }, key);
            setEntry({ shareId: entry.shareId, link: null, key });
          }}
        />
      );
    }
    const [title, detail] =
      failure.kind === "network"
        ? [copy.network, copy.networkDetail]
        : failure.kind === "relay"
          ? failure.status === 503
            ? [copy.offline, copy.offlineDetail]
            : [copy.errors.unavailable, copy.errorDetails.unavailable]
          : [copy.errors[failure.reason], copy.errorDetails[failure.reason]];
    return (
      <GuestNotice title={title} detail={detail}>
        {failure.kind === "refused" ? null : (
          <Button size="sm" variant="outline" onClick={() => void load()}>
            {copy.retry}
          </Button>
        )}
      </GuestNotice>
    );
  }
  return (
    <SharedPage
      copy={copy}
      entry={entry}
      transport={transport}
      visitor={visitor}
      view={stage.view}
      onEditorClosed={() => void load()}
      onSelectPage={(selected) => {
        if (selected === stage.view.page.id) return;
        loadGeneration.current += 1;
        setStage({ kind: "loading" });
        setPageId(selected);
      }}
    />
  );
}

function SharedPage(props: {
  copy: PageGuestCopy;
  entry: PageGuestEntry;
  transport: PageGuestTransport;
  visitor: string;
  view: PageGuestView;
  onSelectPage: (pageId: PageId) => void;
  onEditorClosed: () => void;
}) {
  const { copy, view } = props;
  const [commentsOpen, setCommentsOpen] = useState(view.canComment);
  const [editing, setEditing] = useState(false),
    [dirty, setDirty] = useState(false),
    [saved, setSaved] = useState(false);
  const editable =
    view.mode === "share" &&
    view.role === "edit" &&
    (view.page.kind ?? "page") === "page" &&
    !!props.transport.edit &&
    view.editProjection?.v === 1;
  const selectPage = (id: PageId) => {
    if (id === view.page.id || (dirty && !window.confirm(copy.editor.leave))) return;
    props.onSelectPage(id);
  };
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  const [selectedApp, setSelectedApp] = useState<{
    key: string;
    reference: PageGuestAppReference;
  } | null>(null);
  const showNav = view.pages.length > 1;
  const updated = new Date(view.page.updatedAt);
  const loadImage = useCallback(
    async (itemId: string) => {
      const result = await props.transport.media({
        visitor: props.visitor,
        ...(props.entry.link === null ? {} : { link: props.entry.link }),
        ...(props.entry.key === null ? {} : { key: props.entry.key }),
        pageId: view.page.id,
        revision: view.page.revision,
        itemId,
      });
      return result.ok ? result.value : null;
    },
    [props.transport, props.entry, props.visitor, view.page.id, view.page.revision],
  );
  return (
    <div className={cn("flex h-dvh flex-col text-foreground", CHAT_BACKGROUND_CLASS_NAME)}>
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <MossLogoMark className="size-4 shrink-0" aria-label="Moss" />
        <h1 className="min-w-0 flex-1 truncate text-ui font-medium">
          {view.title || copy.untitled}
        </h1>
        {!editing && (
          <span className="shrink-0 rounded-sm bg-muted px-1.5 py-0.5 text-ui-xs text-muted-foreground">
            {view.mode === "site" ? copy.site : editable ? copy.editor.role : copy.role[view.role]}
          </span>
        )}
        {view.mode === "share" ? (
          <Button size="xs" variant="ghost" onClick={() => setCommentsOpen((open) => !open)}>
            {commentsOpen ? copy.closeComments : copy.comments}
          </Button>
        ) : null}
      </header>
      <div className="flex min-h-0 flex-1">
        {showNav ? (
          <nav
            aria-label={copy.pages}
            className="hidden w-56 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-2 md:flex"
          >
            {view.pages.map((item) => (
              <button
                key={item.id}
                type="button"
                className={cn(
                  "truncate rounded-control px-2 py-1 text-left text-ui-sm",
                  item.parentId !== null && "pl-5",
                  item.id === view.page.id
                    ? "bg-accent text-foreground"
                    : "text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
                aria-current={item.id === view.page.id ? "page" : undefined}
                onClick={() => selectPage(item.id)}
              >
                {item.title || copy.untitled}
              </button>
            ))}
          </nav>
        ) : null}
        <main className="min-w-0 flex-1 overflow-y-auto">
          <article className="mx-auto w-full max-w-3xl px-6 py-10 md:px-10">
            {showNav ? (
              <select
                aria-label={copy.pages}
                className="mb-6 w-full rounded-control border border-border bg-transparent px-2 py-1.5 text-ui-sm md:hidden"
                value={view.page.id}
                onChange={(event) => selectPage(event.target.value as PageId)}
              >
                {view.pages.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.title || copy.untitled}
                  </option>
                ))}
              </select>
            ) : null}
            <h2 className="text-[2rem] font-semibold leading-tight">
              {view.page.title || copy.untitled}
            </h2>
            <p className="mt-2 text-ui-xs text-muted-foreground">
              {copy.updated} {updated.toLocaleDateString()}{" "}
              {updated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
              {view.viewerName ? ` · ${view.viewerName}` : ""}
            </p>
            {editable && props.transport.edit ? (
              editing ? (
                <Suspense fallback={<p role="status">{copy.editor.opening}</p>}>
                  <GuestProjectionEditor
                    key={view.page.id}
                    pageId={view.page.id}
                    transport={props.transport.edit}
                    words={copy.editor}
                    dirty={setDirty}
                    entry={{
                      visitor: props.visitor,
                      ...(props.entry.link === null ? {} : { link: props.entry.link }),
                      ...(props.entry.key === null ? {} : { key: props.entry.key }),
                    }}
                    finish={(didSave) => {
                      setDirty(false);
                      setEditing(false);
                      setSaved(didSave);
                      props.onEditorClosed();
                    }}
                  />
                </Suspense>
              ) : (
                <div className="mt-3 flex items-center gap-3">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => {
                      setSaved(false);
                      setEditing(true);
                    }}
                  >
                    {copy.editor.open}
                  </Button>
                  {saved ? <span role="status">{copy.editor.saved}</span> : null}
                </div>
              )
            ) : view.role === "edit" && view.mode === "share" ? (
              <p className="mt-3 rounded-card bg-muted/60 px-3 py-2 text-ui-sm text-muted-foreground">
                {copy.editNote}
              </p>
            ) : null}
            <div className="mt-6" hidden={editing && editable}>
              {view.page.kind === "app" ? (
                <GuestAppItemPreview
                  key={JSON.stringify([
                    view.page.id,
                    view.page.revision,
                    view.appPreview,
                    props.entry,
                  ])}
                  shareId={props.entry.shareId}
                  view={view}
                  copy={copy}
                  transport={props.transport.appPreview}
                  request={{
                    visitor: props.visitor,
                    ...(props.entry.link === null ? {} : { link: props.entry.link }),
                    ...(props.entry.key === null ? {} : { key: props.entry.key }),
                  }}
                />
              ) : view.page.deck ? (
                <GuestDeckView key={view.page.revision} deck={view.page.deck} copy={copy} />
              ) : (
                <PageRichView
                  key={`${view.page.id}:${view.page.revision}`}
                  richContent={view.page.richContent}
                  content={view.page.content}
                  imageLabel={copy.image}
                  imageNotShared={copy.imageNotShared}
                  {...(view.appPreview && props.transport.appPreview
                    ? {
                        renderApp: (reference: PageGuestAppReference) => {
                          const key = JSON.stringify([
                            props.entry,
                            view.page.id,
                            view.page.revision,
                            reference,
                          ]);
                          if (!selectedApp || selectedApp.key !== key)
                            return (
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setSelectedApp({ key, reference })}
                              >
                                {copy.openPreview}
                              </Button>
                            );
                          return (
                            <GuestAppItemPreview
                              key={key}
                              shareId={props.entry.shareId}
                              view={view}
                              copy={copy}
                              transport={props.transport.appPreview}
                              reference={selectedApp.reference}
                              request={{
                                visitor: props.visitor,
                                ...(props.entry.link === null ? {} : { link: props.entry.link }),
                                ...(props.entry.key === null ? {} : { key: props.entry.key }),
                              }}
                            />
                          );
                        },
                      }
                    : {})}
                  {...(view.canLoadImages ? { loadImage } : {})}
                />
              )}
            </div>
            <footer className="mt-16 text-ui-xs text-muted-foreground">{copy.brand}</footer>
          </article>
        </main>
        {view.mode === "share" && commentsOpen ? (
          <CommentsPanel
            key={view.page.id}
            copy={copy}
            entry={props.entry}
            transport={props.transport}
            visitor={props.visitor}
            pageId={view.page.id}
            canComment={view.canComment}
            viewerName={view.viewerName}
          />
        ) : null}
      </div>
    </div>
  );
}

function CommentsPanel(props: {
  copy: PageGuestCopy;
  entry: PageGuestEntry;
  transport: PageGuestTransport;
  visitor: string;
  pageId: PageId;
  canComment: boolean;
  viewerName: string | null;
}) {
  const { copy, entry, transport } = props;
  const [comments, setComments] = useState<ReadonlyArray<PageGuestComment>>([]);
  const [name, setName] = useState(() => rememberedGuestName());
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const base = {
    visitor: props.visitor,
    pageId: props.pageId,
    ...(entry.link === null ? {} : { link: entry.link }),
    ...(entry.key === null ? {} : { key: entry.key }),
  };
  useEffect(() => {
    let live = true;
    const refresh = () =>
      void transport.comments({ ...base, action: "list" }).then((result) => {
        if (live && result.ok) setComments(result.value.comments);
      });
    refresh();
    const timer = window.setInterval(refresh, 20_000);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
    // The panel is keyed by page; the entry does not change under it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transport, props.pageId]);

  const send = async () => {
    const content = text.trim();
    const author = props.viewerName ?? name.trim();
    if (content === "" || author === "") return;
    setSending(true);
    setError(null);
    const result = await transport.comments({
      ...base,
      action: "add",
      content,
      ...(props.viewerName === null ? { name: author } : {}),
    });
    setSending(false);
    if (result.ok) {
      setComments(result.value.comments);
      setText("");
      if (props.viewerName === null) rememberGuestName(author);
    } else {
      setError(
        result.failure.kind === "refused" ? copy.errors[result.failure.reason] : copy.commentFailed,
      );
    }
  };

  return (
    <aside
      aria-label={copy.comments}
      className="flex w-80 shrink-0 flex-col border-l border-border max-md:absolute max-md:inset-y-11 max-md:right-0 max-md:z-10 max-md:bg-background"
    >
      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {comments.length === 0 ? (
          <p className="text-ui-sm text-muted-foreground">{copy.noComments}</p>
        ) : (
          <ol className="flex flex-col gap-4">
            {comments.map((comment) => (
              <li key={comment.id} className="flex flex-col gap-0.5">
                <span className="text-ui-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {comment.authorKind === "owner" ? copy.owner : comment.authorName}
                  </span>
                  {" · "}
                  {new Date(comment.createdAt).toLocaleString([], {
                    month: "numeric",
                    day: "numeric",
                    hour: "2-digit",
                    minute: "2-digit",
                  })}
                </span>
                <p className="whitespace-pre-wrap text-ui-sm">{comment.content}</p>
              </li>
            ))}
          </ol>
        )}
      </div>
      {props.canComment ? (
        <form
          className="flex flex-col gap-2 border-t border-border p-3"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
        >
          {props.viewerName === null ? (
            <Input
              size="sm"
              aria-label={copy.yourName}
              placeholder={copy.yourName}
              maxLength={60}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          ) : null}
          <Textarea
            aria-label={copy.commentPlaceholder}
            placeholder={copy.commentPlaceholder}
            maxLength={4000}
            value={text}
            onChange={(event) => setText(event.target.value)}
            className="min-h-20"
          />
          {error ? (
            <p role="alert" className="text-ui-xs text-destructive">
              {error}
            </p>
          ) : null}
          <Button
            type="submit"
            size="sm"
            disabled={
              sending || text.trim() === "" || (props.viewerName === null && name.trim() === "")
            }
          >
            {sending ? copy.sending : copy.send}
          </Button>
        </form>
      ) : null}
    </aside>
  );
}

type RequestState =
  | { readonly kind: "form" }
  | { readonly kind: "pending"; readonly requestId: string; readonly secret: string }
  | { readonly kind: "rejected" };

function readStoredRequest(entry: PageGuestEntry): RequestState {
  try {
    const raw = localStorage.getItem(REQUEST_SLOT(entry));
    if (raw === null) return { kind: "form" };
    const parsed = JSON.parse(raw) as { requestId?: unknown; secret?: unknown };
    return typeof parsed.requestId === "string" && typeof parsed.secret === "string"
      ? { kind: "pending", requestId: parsed.requestId, secret: parsed.secret }
      : { kind: "form" };
  } catch {
    return { kind: "form" };
  }
}

function AccessRequest(props: {
  copy: PageGuestCopy;
  entry: PageGuestEntry;
  transport: PageGuestTransport;
  visitor: string;
  onApproved: (key: string) => void;
}) {
  const { copy, entry, transport, visitor, onApproved } = props;
  const [state, setState] = useState<RequestState>(() => readStoredRequest(entry));
  const [name, setName] = useState(() => rememberedGuestName());
  const [contact, setContact] = useState("");
  const [note, setNote] = useState("");
  const [role, setRole] = useState<Exclude<PageShareRole, "edit">>("view");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (state.kind !== "pending") return;
    let live = true;
    const poll = async () => {
      const result = await transport.access({
        visitor,
        action: "status",
        requestId: state.requestId,
        secret: state.secret,
      });
      if (!live || !result.ok) return;
      if (result.value.status === "approved" && result.value.key) {
        localStorage.removeItem(REQUEST_SLOT(entry));
        onApproved(result.value.key);
      } else if (result.value.status === "rejected") {
        localStorage.removeItem(REQUEST_SLOT(entry));
        setState({ kind: "rejected" });
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), REQUEST_POLL_MS);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [state, transport, visitor, entry, onApproved]);

  if (state.kind === "pending") {
    return <GuestNotice title={copy.request.pending} detail={copy.request.pendingDetail} busy />;
  }
  if (state.kind === "rejected") {
    return <GuestNotice title={copy.request.rejected} detail={copy.request.rejectedDetail} />;
  }
  const submit = async () => {
    if (name.trim() === "" || entry.link === null) return;
    setSending(true);
    setError(null);
    const result = await transport.access({
      visitor,
      action: "request",
      link: entry.link,
      name: name.trim(),
      role,
      ...(contact.trim() ? { contact: contact.trim() } : {}),
      ...(note.trim() ? { note: note.trim() } : {}),
    });
    setSending(false);
    if (!result.ok || result.value.secret === undefined) {
      setError(
        !result.ok && result.failure.kind === "refused"
          ? copy.errors[result.failure.reason]
          : copy.request.failed,
      );
      return;
    }
    rememberGuestName(name.trim());
    const pending = { requestId: result.value.requestId, secret: result.value.secret };
    try {
      localStorage.setItem(REQUEST_SLOT(entry), JSON.stringify(pending));
    } catch {
      // Polling still works while this tab stays open.
    }
    setState({ kind: "pending", ...pending });
  };
  return (
    <GuestNotice title={copy.errors["invite-only"]} detail={copy.errorDetails["invite-only"]}>
      <form
        className="flex w-full flex-col gap-2 text-left"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <Field label={copy.request.name}>
          <Input
            size="sm"
            maxLength={60}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </Field>
        <Field label={copy.request.contact}>
          <Input
            size="sm"
            maxLength={120}
            value={contact}
            onChange={(event) => setContact(event.target.value)}
          />
        </Field>
        <Field label={copy.request.note}>
          <Textarea
            maxLength={500}
            value={note}
            onChange={(event) => setNote(event.target.value)}
            className="min-h-16"
          />
        </Field>
        <fieldset className="flex items-center gap-3 text-ui-sm">
          <legend className="sr-only">{copy.request.role}</legend>
          <span className="text-muted-foreground">{copy.request.role}</span>
          {(["view", "comment"] as const).map((option) => (
            <label key={option} className="flex items-center gap-1">
              <input
                type="radio"
                name="role"
                value={option}
                checked={role === option}
                onChange={() => setRole(option)}
              />
              {copy.roleOptions[option]}
            </label>
          ))}
        </fieldset>
        {error ? (
          <p role="alert" className="text-ui-xs text-destructive">
            {error}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={sending || name.trim() === ""}>
          {sending ? copy.request.sending : copy.request.submit}
        </Button>
      </form>
    </GuestNotice>
  );
}

function Field(props: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-ui-xs text-muted-foreground">
      {props.label}
      {props.children}
    </label>
  );
}
