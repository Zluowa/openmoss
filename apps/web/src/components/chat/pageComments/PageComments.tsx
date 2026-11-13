// FILE: PageComments.tsx
// Purpose: Comments on a visual page in the right-hand panel: comment mode, the pins on
//   commented elements, the new-comment and thread cards, the All comments list, and
//   sending a comment to the agent with its answer coming back into the thread card.
// Layer: Chat right-dock UI
// Spec: docs/design/annotate-and-comment/SPEC.md, "Page comments".

import {
  htmlRenderCommentAnchorsMessage,
  htmlRenderCommentModeMessage,
  htmlRenderCommentRevealMessage,
  type HtmlRenderCommentRect,
  readHtmlRenderCommentPick,
  readHtmlRenderCommentRects,
} from "@moss/shared/htmlRender";
import type { ThreadId } from "@moss/contracts";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { ArrowUpIcon, MicIcon, SortIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import { useVoiceRecorder } from "~/lib/voiceRecorder";
import { readNativeApi } from "~/nativeApi";

import {
  newPageCommentId,
  type PageComment,
  type PageCommentAnchor,
  type PageCommentAuthor,
  PAGE_COMMENT_MAX_LENGTH,
  pageCommentAge,
  pageCommentAgentMessage,
  usePageComments,
  usePageCommentsStore,
} from "../../../pageCommentsStore";
import { useStore } from "../../../store";
import { createProjectSelector, createThreadSelector } from "../../../storeSelectors";
import { useThreadSendRequestStore } from "../../../threadSendRequestStore";
import { MossLogoMark } from "../../MossLogoMark";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { IconButton } from "../../ui/icon-button";
import {
  PAGE_COMMENT_CARD_MAX_HEIGHT,
  PAGE_COMMENT_CARD_WIDTH,
  PAGE_COMMENT_PIN_SIZE,
  type PaneSize,
  pageCommentInitials,
  pageCommentMentionsAgent,
  placePageCommentCard,
  placePageCommentPin,
  removePageCommentAgentMention,
  resolvePageCommentAgentReply,
} from "./pageComments.logic";

const AGENT_NAME = "Moss";
// Comment fields are prose, not code: the global field reset would make them monospace.
const UI_FONT = { fontFamily: "var(--font-ui-family)" } as const;

// ---------------------------------------------------------------------------------------
// Small parts

function PageCommentAvatar(props: {
  readonly initials: string;
  readonly size: number;
  readonly agent?: boolean;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full font-medium leading-none",
        props.agent
          ? "bg-[color-mix(in_srgb,var(--foreground)_5%,var(--popover))]"
          : "bg-[var(--color-text-accent)] text-white",
      )}
      style={{ width: props.size, height: props.size, fontSize: Math.round(props.size * 0.42) }}
    >
      {props.agent ? <MossLogoMark className="size-[62%]" /> : Array.from(props.initials)[0]}
    </span>
  );
}

function CardFrame(props: {
  readonly children: ReactNode;
  readonly style?: React.CSSProperties;
  readonly label: string;
  readonly pulse?: boolean;
}) {
  return (
    <div
      role="group"
      aria-label={props.label}
      data-page-comment-card=""
      onPointerDown={(event) => event.stopPropagation()}
      className={cn(
        "pointer-events-auto absolute flex flex-col overflow-hidden rounded-panel border border-border bg-popover text-popover-foreground shadow-lg",
        "motion-safe:animate-[moss-comment-card-in_280ms_cubic-bezier(.4,0,.2,1)]",
        props.pulse &&
          "motion-safe:animate-[moss-comment-pulse_1.3s_ease-out] outline-2 outline-solid",
      )}
      style={{
        width: PAGE_COMMENT_CARD_WIDTH,
        maxHeight: PAGE_COMMENT_CARD_MAX_HEIGHT,
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}

function Breadcrumb(props: { readonly pageTitle: string; readonly anchor: PageCommentAnchor }) {
  return (
    <div className="flex min-w-0 items-center gap-1 text-ui-sm text-muted-foreground">
      <span className="min-w-0 truncate">{props.pageTitle}</span>
      <span aria-hidden>›</span>
      <span className="min-w-0 shrink-0 truncate font-mono text-ui-2xs">{props.anchor.label}</span>
    </div>
  );
}

/** Microphone that types what the reader says into the field. */
function DictationButton(props: {
  readonly threadId: string;
  readonly onText: (text: string) => void;
}) {
  const recorder = useVoiceRecorder();
  const [busy, setBusy] = useState(false);
  const thread = useStore(
    useMemo(() => createThreadSelector(props.threadId as ThreadId), [props.threadId]),
  );
  const project = useStore(
    useMemo(() => createProjectSelector(thread?.projectId), [thread?.projectId]),
  );
  const cwd = thread?.worktreePath ?? project?.cwd ?? null;
  const api = readNativeApi();
  const toggle = () => {
    if (recorder.isRecording) {
      setBusy(true);
      void recorder
        .stopRecording()
        .then((payload) =>
          payload && api && cwd
            ? api.server.transcribeVoice({
                provider: "codex",
                cwd,
                threadId: props.threadId as ThreadId,
                ...payload,
              })
            : null,
        )
        .then((result) => {
          if (result?.text) props.onText(result.text);
        })
        .catch(() => undefined)
        .finally(() => setBusy(false));
      return;
    }
    void recorder.startRecording().catch(() => undefined);
  };
  const label = recorder.isRecording ? "Stop dictation" : "Dictate";
  return (
    <IconButton
      label={label}
      tooltip={label}
      className={cn(
        "size-7 text-muted-foreground hover:text-foreground",
        recorder.isRecording && "text-destructive hover:text-destructive",
      )}
      disabled={busy || !cwd || !api}
      data-page-comment-mic=""
      onClick={toggle}
    >
      <MicIcon className={cn(recorder.isRecording && "motion-safe:animate-pulse")} />
    </IconButton>
  );
}

// ---------------------------------------------------------------------------------------
// New comment

export function NewCommentCard(props: {
  readonly threadId: string;
  readonly pageTitle: string;
  readonly anchor: PageCommentAnchor;
  readonly position: { left: number; top: number };
  readonly onPost: (body: string, sendToAgent: boolean) => void;
  readonly onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [sendToAgent, setSendToAgent] = useState(false);
  const fieldRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => fieldRef.current?.focus(), []);
  const asksAgent = sendToAgent;
  const text = body.trim();
  const post = () => {
    if (text.length === 0) return;
    props.onPost(text, asksAgent);
  };
  return (
    <CardFrame label="New comment" style={props.position}>
      <div className="flex flex-col gap-2 p-3">
        <Breadcrumb pageTitle={props.pageTitle} anchor={props.anchor} />
        <div className="flex flex-wrap items-start gap-1.5">
          {asksAgent ? (
            <span
              data-page-comment-mention=""
              className="mt-0.5 inline-flex h-5 shrink-0 items-center rounded-full border border-[color-mix(in_srgb,var(--color-text-accent)_35%,transparent)] bg-[color-mix(in_srgb,var(--color-text-accent)_8%,transparent)] px-2 text-ui-sm font-medium text-[var(--color-text-accent)]"
            >
              @{AGENT_NAME}
            </span>
          ) : null}
          <textarea
            ref={fieldRef}
            aria-label="Comment"
            rows={1}
            maxLength={PAGE_COMMENT_MAX_LENGTH}
            value={body}
            placeholder={asksAgent ? "Ask Moss about this…" : "Add a comment…"}
            style={UI_FONT}
            className="min-h-6 min-w-24 flex-1 resize-none bg-transparent text-ui leading-6 text-foreground outline-none [field-sizing:content] max-h-40 placeholder:text-muted-foreground/70"
            onChange={(event) => {
              // A typed @Moss becomes the chip, so the text never carries it twice.
              const value = event.target.value;
              if (pageCommentMentionsAgent(value)) {
                setSendToAgent(true);
                setBody(removePageCommentAgentMention(value));
              } else {
                setBody(value);
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                post();
              } else if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                props.onCancel();
              }
            }}
          />
        </div>
        <div className="flex items-center gap-1">
          <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-ui text-foreground">
            <Checkbox
              checked={asksAgent}
              onCheckedChange={(checked) => {
                setSendToAgent(checked === true);
              }}
              data-page-comment-send-to-agent=""
            />
            <span className="truncate">{`Send to ${AGENT_NAME}`}</span>
          </label>
          <DictationButton
            threadId={props.threadId}
            onText={(spoken) => setBody((current) => (current ? `${current} ${spoken}` : spoken))}
          />
          <IconButton
            label="Post comment"
            tooltip="Post (Enter)"
            variant="default"
            className="size-7 rounded-full"
            disabled={text.length === 0}
            data-page-comment-post=""
            onClick={post}
          >
            <ArrowUpIcon />
          </IconButton>
        </div>
      </div>
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------------------
// Thread

function CommentEntry(props: {
  readonly author: PageCommentAuthor;
  readonly agentVia?: string | undefined;
  readonly createdAt: string;
  readonly body: ReactNode;
  readonly sentToAgent?: boolean;
}) {
  const name = props.agentVia ? `${AGENT_NAME} · via ${props.agentVia}` : props.author.name;
  return (
    <div className="flex gap-2.5">
      <PageCommentAvatar
        initials={props.author.initials}
        size={28}
        agent={props.agentVia !== undefined}
      />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 truncate text-ui font-medium text-foreground">{name}</span>
          <span className="shrink-0 text-ui-sm text-muted-foreground">
            {pageCommentAge(props.createdAt)}
          </span>
          {props.sentToAgent ? (
            <MossLogoMark aria-label={`Sent to ${AGENT_NAME}`} className="size-3.5 shrink-0" />
          ) : null}
        </div>
        <div className="mt-0.5 whitespace-pre-wrap break-words text-ui leading-5 text-foreground">
          {props.body}
        </div>
      </div>
    </div>
  );
}

function AgentReplyBody(props: { readonly status: string; readonly body: string }) {
  if (props.status === "thinking") {
    return <span className="text-muted-foreground motion-safe:animate-pulse">thinking…</span>;
  }
  if (props.status === "failed") {
    return <span className="text-muted-foreground">Moss finished without replying here.</span>;
  }
  return <span className="line-clamp-[12]">{props.body}</span>;
}

export function ThreadCard(props: {
  readonly comment: PageComment;
  readonly position: { left: number; top: number };
  readonly pulse: boolean;
  readonly author: PageCommentAuthor;
  readonly onReply: (body: string) => void;
  readonly onDelete: () => void;
  readonly onClose: () => void;
}) {
  const [reply, setReply] = useState("");
  const { comment } = props;
  return (
    <CardFrame label="Comment thread" style={props.position} pulse={props.pulse}>
      <div className="flex items-center justify-between gap-2 px-3 pt-2.5">
        <span className="min-w-0 truncate font-mono text-ui-2xs text-muted-foreground">
          {comment.anchor.label}
        </span>
        <div className="flex items-center">
          <Button
            size="xs"
            variant="ghost"
            className="h-6 px-1.5 text-muted-foreground"
            onClick={props.onDelete}
          >
            Delete
          </Button>
          <IconButton
            label="Close comment"
            className="size-6 text-muted-foreground"
            onClick={props.onClose}
          >
            <XIcon />
          </IconButton>
        </div>
      </div>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 py-2.5">
        <CommentEntry
          author={comment.author}
          createdAt={comment.createdAt}
          body={comment.body}
          sentToAgent={comment.sentToAgentAt !== null}
        />
        {comment.replies.map((entry) => (
          <CommentEntry
            key={entry.id}
            author={entry.author}
            agentVia={entry.kind === "agent" ? entry.author.name : undefined}
            createdAt={entry.createdAt}
            body={
              entry.kind === "agent" ? (
                <AgentReplyBody status={entry.status} body={entry.body} />
              ) : (
                entry.body
              )
            }
          />
        ))}
      </div>
      <div className="border-border/70 border-t px-3 py-2">
        <textarea
          aria-label="Reply"
          rows={1}
          value={reply}
          maxLength={PAGE_COMMENT_MAX_LENGTH}
          placeholder="Reply…"
          style={UI_FONT}
          className="w-full resize-none bg-transparent text-ui leading-5 outline-none [field-sizing:content] max-h-24 placeholder:text-muted-foreground/70"
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              if (reply.trim()) {
                props.onReply(reply.trim());
                setReply("");
              }
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              props.onClose();
            }
          }}
        />
      </div>
    </CardFrame>
  );
}

// ---------------------------------------------------------------------------------------
// Pin

export function CommentPin(props: {
  readonly comment: PageComment;
  readonly left: number;
  readonly top: number;
  readonly side: "above" | "below";
  readonly open: boolean;
  readonly pulse: boolean;
  readonly onOpen: () => void;
}) {
  const unread = !props.comment.read;
  const avatar = Math.round(PAGE_COMMENT_PIN_SIZE - 12);
  return (
    <button
      type="button"
      data-page-comment-pin={props.comment.id}
      data-unread={unread ? "" : undefined}
      aria-label={`${unread ? "Unread comment" : "Comment"} from ${props.comment.author.name}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={props.onOpen}
      className={cn(
        "pointer-events-auto absolute flex items-center justify-center rounded-full border border-border bg-popover shadow-sm transition-[box-shadow,transform] duration-[60ms] hover:scale-105 focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none",
        props.side === "above" ? "rounded-bl-none" : "rounded-tl-none",
        props.open && "ring-2 ring-[color-mix(in_srgb,var(--color-text-accent)_40%,transparent)]",
        props.pulse &&
          "outline-2 outline-solid motion-safe:animate-[moss-comment-pulse_1.3s_ease-out]",
      )}
      style={{
        left: props.left,
        top: props.top,
        width: PAGE_COMMENT_PIN_SIZE,
        height: PAGE_COMMENT_PIN_SIZE,
      }}
    >
      <PageCommentAvatar initials={props.comment.author.initials} size={avatar} />
      {unread ? (
        <span
          aria-hidden
          className="absolute -top-0.5 -right-0.5 size-2.5 rounded-full bg-[var(--color-text-accent)] ring-2 ring-popover"
        />
      ) : null}
    </button>
  );
}

// ---------------------------------------------------------------------------------------
// All comments

export function PageCommentsPanel(props: {
  readonly comments: readonly PageComment[];
  readonly onPick: (comment: PageComment) => void;
  readonly onClose: () => void;
}) {
  const [newestFirst, setNewestFirst] = useState(true);
  const ordered = useMemo(() => {
    const list = props.comments.toSorted(
      (a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt),
    );
    return newestFirst ? list.toReversed() : list;
  }, [newestFirst, props.comments]);
  return (
    <div
      role="dialog"
      aria-label="All comments"
      data-page-comments-panel=""
      onPointerDown={(event) => event.stopPropagation()}
      className="pointer-events-auto absolute top-2 right-2 z-30 flex max-h-[calc(100%-16px)] w-[360px] max-w-[calc(100%-24px)] flex-col overflow-hidden rounded-panel border border-border bg-popover text-popover-foreground shadow-lg motion-safe:animate-[moss-comment-card-in_280ms_cubic-bezier(.4,0,.2,1)]"
    >
      <div className="flex items-center gap-1 py-2 ps-3.5 pe-2">
        <span className="flex-1 text-ui font-medium">All comments</span>
        <IconButton
          label={newestFirst ? "Newest first" : "Oldest first"}
          tooltip={newestFirst ? "Newest first" : "Oldest first"}
          className="size-7 text-muted-foreground"
          data-page-comments-sort={newestFirst ? "newest" : "oldest"}
          onClick={() => setNewestFirst((value) => !value)}
        >
          <SortIcon />
        </IconButton>
        <IconButton
          label="Close comments"
          className="size-7 text-muted-foreground"
          onClick={props.onClose}
        >
          <XIcon />
        </IconButton>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1.5 pb-1.5">
        {ordered.length === 0 ? (
          <p className="px-2 pt-1 pb-3 text-ui-sm text-muted-foreground">
            No comments yet. Turn on comment mode, then click anywhere on the page.
          </p>
        ) : (
          ordered.map((comment) => (
            <button
              key={comment.id}
              type="button"
              data-page-comments-row={comment.id}
              onClick={() => props.onPick(comment)}
              className="flex w-full flex-col gap-1 rounded-control px-2 py-2 text-left transition-colors duration-[60ms] hover:bg-[color-mix(in_srgb,var(--foreground)_4%,transparent)]"
            >
              <CommentEntry
                author={comment.author}
                createdAt={comment.createdAt}
                body={<span className="line-clamp-3">{comment.body}</span>}
                sentToAgent={comment.sentToAgentAt !== null}
              />
              {comment.replies.length > 0 ? (
                <span className="ps-[38px] text-ui-sm font-medium text-[var(--color-text-accent)]">
                  {comment.replies.length === 1 ? "1 reply" : `${comment.replies.length} replies`}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------
// Layer over the page

interface DraftAnchor {
  readonly anchor: PageCommentAnchor;
  readonly rect: HtmlRenderCommentRect;
}

/** Keeps sent comments' agent replies in step with the thread. */
function useAgentReplySync(threadId: string, pageKey: string, comments: readonly PageComment[]) {
  const thread = useStore(useMemo(() => createThreadSelector(threadId as ThreadId), [threadId]));
  const updateReply = usePageCommentsStore((store) => store.updateReply);
  useEffect(() => {
    for (const comment of comments) {
      const pending = comment.replies.find(
        (reply) => reply.kind === "agent" && reply.status === "thinking",
      );
      if (!pending) continue;
      const state = resolvePageCommentAgentReply(thread, comment);
      if (state.status === "done") {
        updateReply(pageKey, comment.id, pending.id, {
          status: "done",
          body: state.text,
          createdAt: new Date().toISOString(),
        });
      } else if (state.status === "failed") {
        updateReply(pageKey, comment.id, pending.id, { status: "failed" });
      }
    }
  }, [comments, pageKey, thread, updateReply]);
}

export function PageCommentsLayer(props: {
  readonly frame: HTMLIFrameElement | null;
  /** Bumped on every frame load, so mode and anchors are sent to the new document. */
  readonly frameGeneration: number;
  readonly threadId: string;
  readonly pageKey: string;
  readonly pageTitle: string;
  readonly zoom: number;
  readonly commentMode: boolean;
  readonly onCommentModeChange: (on: boolean) => void;
  readonly panelOpen: boolean;
  readonly onPanelOpenChange: (open: boolean) => void;
  readonly markersVisible: boolean;
}) {
  const { frame, pageKey, threadId } = props;
  const comments = usePageComments(pageKey);
  const addComment = usePageCommentsStore((store) => store.addComment);
  const addReply = usePageCommentsStore((store) => store.addReply);
  const deleteComment = usePageCommentsStore((store) => store.deleteComment);
  const markPageRead = usePageCommentsStore((store) => store.markPageRead);
  const requestSend = useThreadSendRequestStore((store) => store.request);
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () => ({
      name: identity.kind === "authenticated" || identity.kind === "saved" ? identity.label : "You",
      initials:
        identity.kind === "authenticated" || identity.kind === "saved"
          ? identity.initials
          : pageCommentInitials("You"),
    }),
    [identity],
  );
  const hostRef = useRef<HTMLDivElement>(null);
  const [pane, setPane] = useState<PaneSize>({ width: 0, height: 0 });
  const [rects, setRects] = useState<Readonly<Record<string, HtmlRenderCommentRect | null>>>({});
  const [draft, setDraft] = useState<DraftAnchor | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [pulseId, setPulseId] = useState<string | null>(null);

  useAgentReplySync(threadId, pageKey, comments);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const measure = () => setPane({ width: host.clientWidth, height: host.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, []);

  const post = useCallback(
    (message: unknown) => frame?.contentWindow?.postMessage(message, "*"),
    [frame],
  );

  useEffect(() => {
    post(htmlRenderCommentModeMessage(props.commentMode));
  }, [post, props.commentMode, props.frameGeneration]);

  const anchors = useMemo(
    () => [
      ...comments.map((comment) => ({ id: comment.id, selector: comment.anchor.selector })),
      ...(draft ? [{ id: "draft", selector: draft.anchor.selector }] : []),
    ],
    [comments, draft],
  );
  useEffect(() => {
    post(htmlRenderCommentAnchorsMessage(anchors));
  }, [anchors, post, props.frameGeneration]);

  // Opening the page's comments reads them.
  useEffect(() => {
    if (props.panelOpen || openId) markPageRead(pageKey);
  }, [markPageRead, openId, pageKey, props.panelOpen, comments]);

  useEffect(() => {
    if (!frame) return;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.contentWindow) return;
      const pick = readHtmlRenderCommentPick(event.data);
      if (pick) {
        setOpenId(null);
        setDraft({
          anchor: { selector: pick.selector, label: pick.label, text: pick.text },
          rect: pick.rect,
        });
        return;
      }
      const update = readHtmlRenderCommentRects(event.data);
      if (update) setRects(update.rects);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frame]);

  // Escape leaves comment mode once no card is open (cards handle their own Escape).
  useEffect(() => {
    if (!props.commentMode) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      if (draft || openId) {
        setDraft(null);
        setOpenId(null);
        return;
      }
      props.onCommentModeChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [draft, openId, props]);

  useEffect(() => {
    if (!pulseId) return;
    const timer = window.setTimeout(() => setPulseId(null), 1_400);
    return () => window.clearTimeout(timer);
  }, [pulseId]);

  const submit = (body: string, sendToAgent: boolean) => {
    if (!draft) return;
    const now = new Date().toISOString();
    const comment: PageComment = {
      id: newPageCommentId(),
      pageKey,
      threadId,
      anchor: draft.anchor,
      author: me,
      body,
      createdAt: now,
      sentToAgentAt: sendToAgent ? now : null,
      replies: sendToAgent
        ? [
            {
              id: newPageCommentId(),
              kind: "agent",
              author: me,
              body: "",
              createdAt: now,
              status: "thinking",
            },
          ]
        : [],
      read: true,
    };
    addComment(comment);
    setDraft(null);
    setOpenId(comment.id);
    if (sendToAgent) {
      requestSend(
        threadId,
        pageCommentAgentMessage({ pageTitle: props.pageTitle, anchor: draft.anchor, body }),
      );
    }
  };

  const reveal = (comment: PageComment) => {
    post(htmlRenderCommentRevealMessage(comment.anchor.selector));
    setDraft(null);
    setOpenId(comment.id);
    setPulseId(comment.id);
  };

  const draftPin = draft ? placePageCommentPin(rects.draft ?? draft.rect, props.zoom, pane) : null;
  const openComment = openId ? comments.find((comment) => comment.id === openId) : undefined;
  const openRect = openComment ? rects[openComment.id] : null;
  const openPin = openRect ? placePageCommentPin(openRect, props.zoom, pane) : null;

  return (
    <div
      ref={hostRef}
      data-page-comments-layer=""
      className="pointer-events-none absolute inset-0 z-10 overflow-hidden"
      onPointerDown={() => {
        setOpenId(null);
      }}
    >
      {props.markersVisible
        ? comments.map((comment) => {
            const rect = rects[comment.id];
            const pin = rect ? placePageCommentPin(rect, props.zoom, pane) : null;
            return pin ? (
              <CommentPin
                key={comment.id}
                comment={comment}
                left={pin.left}
                top={pin.top}
                side={pin.side}
                open={openId === comment.id}
                pulse={pulseId === comment.id}
                onOpen={() => {
                  setDraft(null);
                  setOpenId((current) => (current === comment.id ? null : comment.id));
                }}
              />
            ) : null;
          })
        : null}
      {draft && draftPin ? (
        <>
          <span
            aria-hidden
            className={cn(
              "absolute flex items-center justify-center rounded-full border border-[var(--color-text-accent)] bg-popover shadow-sm",
              draftPin.side === "above" ? "rounded-bl-none" : "rounded-tl-none",
            )}
            style={{
              left: draftPin.left,
              top: draftPin.top,
              width: PAGE_COMMENT_PIN_SIZE,
              height: PAGE_COMMENT_PIN_SIZE,
            }}
          >
            <PageCommentAvatar initials={me.initials} size={PAGE_COMMENT_PIN_SIZE - 12} />
          </span>
          <NewCommentCard
            key={`${draft.anchor.selector}`}
            threadId={threadId}
            pageTitle={props.pageTitle}
            anchor={draft.anchor}
            position={placePageCommentCard(draftPin, pane)}
            onPost={submit}
            onCancel={() => setDraft(null)}
          />
        </>
      ) : null}
      {openComment ? (
        <ThreadCard
          comment={openComment}
          author={me}
          pulse={pulseId === openComment.id}
          position={placePageCommentCard(
            openPin ?? { left: pane.width - PAGE_COMMENT_PIN_SIZE - 8, top: 48 },
            pane,
          )}
          onReply={(body) =>
            addReply(pageKey, openComment.id, {
              id: newPageCommentId(),
              kind: "person",
              author: me,
              body,
              createdAt: new Date().toISOString(),
              status: "done",
            })
          }
          onDelete={() => {
            deleteComment(pageKey, openComment.id);
            setOpenId(null);
          }}
          onClose={() => setOpenId(null)}
        />
      ) : null}
      {props.panelOpen ? (
        <PageCommentsPanel
          comments={comments}
          onPick={reveal}
          onClose={() => props.onPanelOpenChange(false)}
        />
      ) : null}
    </div>
  );
}
