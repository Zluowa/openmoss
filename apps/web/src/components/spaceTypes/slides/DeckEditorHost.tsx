// FILE: DeckEditorHost.tsx
// Purpose: Opens a 幻灯片 in the Moss Canvas deck editor (iframe /canvas/deck-editor.html) and
//          serves it: saves its changes, runs its AI change requests through the selected Moss
//          agent, relays the agent's proposed changes for review, uploads/generates pictures,
//          exports PPTX (current or basic fonts) / PDF / web page / PNG, presents, copies slide
//          links, and opens sharing. When the editor cannot load (an
//          older Canvas build), the same deck opens in Moss's own viewer with review, AI
//          requests, present and export, so nothing is lost.
// Layer: 资料空间 幻灯片 (host side of slides/DECK-SCHEMA.md §4)

import {
  PROVIDER_DISPLAY_NAMES,
  type PageDraft,
  type PagesReadResult,
  type PageTypedItem,
  type SpaceId,
} from "@moss/contracts";
import { applyDeckOps, diffDecks, type DeckOp } from "@moss/shared/spaceItems/deckOps";
import type { SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useTheme } from "~/hooks/useTheme";
import { downloadBlob } from "~/lib/browserDownload";
import {
  DeckEditorChannel,
  type DeckEditorDraft,
  type DeckEditorEvent,
  type DeckExportQuality,
  type DeckTarget,
  type DeckViewContext,
} from "~/lib/deckEditorChannel";
import { spacePageSlideLink, takeStartSlide } from "~/lib/spacePageLink";
import { uploadLibraryFiles } from "~/lib/libraryUpload";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import { ensureNativeApi } from "~/nativeApi";
import { usePageComments, usePageCommentsStore, type PageCommentAuthor } from "~/pageCommentsStore";
import { PageShareDialog } from "../../pages/sharing/PageShareDialog";
import { pageCommentInitials } from "../../chat/pageComments/pageComments.logic";
import { useCurrentAccountIdentity } from "../../SidebarAccountMenu";
import { Button } from "../../ui/button";
import { toastManager } from "../../ui/toast";
import {
  deckChangePrompt,
  deckGeneratePrompt,
  deckImagePrompt,
  takeDeckGeneration,
  type DeckAiTurnPrompt,
} from "./deckAiPrompt";
import {
  DeckCommentAgentReplies,
  deckCommentsKey,
  deckCommentThreads,
  postDeckComment,
} from "./deckComments";
import { DeckViewer } from "./DeckViewer";
import { SlidesPresenter } from "./SlidesPresenter";

const EDITOR_TIMEOUT_MS = 12_000;
const RUN_TIMEOUT_MS = 10 * 60_000;

export interface DeckRun {
  readonly requestId: string;
  readonly instruction: string;
  readonly target: DeckTarget | null;
  readonly threadId: string | null;
  readonly startedAt: number;
  readonly status: "starting" | "running" | "failed";
}

/** Open deck drafts of one page, with their parsed operations. */
export interface DeckDraftView {
  readonly draft: PageDraft;
  readonly ops: DeckOp[];
  readonly target: DeckTarget | null;
}

export function deckDraftsOf(drafts: readonly PageDraft[]): DeckDraftView[] {
  return drafts.flatMap((draft) => {
    const op = draft.ops[0];
    if (!op || op.kind !== "deck" || draft.status !== "open") return [];
    try {
      const ops = JSON.parse(op.deckOps) as DeckOp[];
      return [
        {
          draft,
          ops,
          target: op.target
            ? { slideIds: [...op.target.slideIds], elementIds: [...op.target.elementIds] }
            : null,
        },
      ];
    } catch {
      return [];
    }
  });
}

const fileName = (title: string, ext: string) =>
  `${
    title
      .replace(/[\\/:*?"<>|]/gu, "_")
      .trim()
      .slice(0, 80) || "幻灯片"
  }.${ext}`;

const pickFile = (accept: string) =>
  new Promise<File | null>((resolve) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });
export function DeckEditorHost(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  item: PageTypedItem;
  deck: SlidesDeck;
  title: string;
  readOnly: boolean;
  /** Bumped when the deck was replaced from outside the editor (conflict reload, accept). */
  epoch: number;
  onChange: (deck: SlidesDeck) => void;
  /** Replaces the deck from Moss's side (accepting a change); the editor reloads it. */
  onReplace: (deck: SlidesDeck) => void;
  onTitle: (title: string) => void;
  /** Saves pending changes; false if they could not be saved. */
  flush: () => Promise<boolean>;
  /** The saved revision right now (after a flush). */
  revision: () => number;
  /** The host's save state, shown in the editor's title pill. */
  saveState?: "saved" | "dirty" | "saving" | "failed" | "conflict";
  /** Re-reads the item and reloads it when someone else (an agent) saved a newer revision. */
  reloadIfChanged?: () => Promise<boolean>;
}) {
  const client = useQueryClient();
  const { resolvedTheme } = useTheme();
  const frame = useRef<HTMLIFrameElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [nonce] = useState(() => crypto.randomUUID());
  const [ready, setReady] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [presenting, setPresenting] = useState<{
    index: number;
    surface: "fullscreen" | "presenter";
  } | null>(null);
  const [sharing, setSharing] = useState(false);
  const [runs, setRuns] = useState<DeckRun[]>([]);
  const view = useRef<DeckViewContext | null>(null);
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const page = props.item.page;
  const startAccount = useRef(props.account);

  const src = useMemo(() => {
    const url = new URL(resolveWsHttpUrl("/canvas/deck-editor.html"), window.location.origin);
    url.searchParams.delete("token");
    url.searchParams.set("moss_deck_editor", "1");
    url.searchParams.set("sessionNonce", nonce);
    url.searchParams.set("moss_parent_origin", window.location.origin);
    return url.toString();
  }, [nonce]);
  const origin = new URL(src).origin;
  const [channel] = useState(
    () =>
      new DeckEditorChannel(
        nonce,
        (message) => frame.current?.contentWindow?.postMessage(message, origin),
        (isReady) => {
          setReady(isReady);
          if (isReady) setError(null);
        },
        setError,
      ),
  );

  // ── Drafts (the agent's proposed changes) ──────────────────────────────────────────────
  const active = runs.some((run) => run.status !== "failed");
  const draftsKey = ["deck-drafts", props.account, props.scopeSpaceId, page.id] as const;
  const draftsQuery = useQuery({
    queryKey: draftsKey,
    queryFn: () =>
      ensureNativeApi().pages.drafts({ scopeSpaceId: props.scopeSpaceId, pageId: page.id }),
    refetchInterval: active ? 2_500 : 15_000,
  });
  const drafts = useMemo(() => deckDraftsOf(draftsQuery.data?.drafts ?? []), [draftsQuery.data]);
  const refreshDrafts = useCallback(
    () => client.invalidateQueries({ queryKey: draftsKey }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [client, page.id],
  );
  // A run ends when its conversation proposes a change (or after a long timeout).
  useEffect(() => {
    setRuns((current) =>
      current.filter(
        (run) =>
          Date.now() - run.startedAt < RUN_TIMEOUT_MS &&
          !(
            run.threadId &&
            drafts.some(
              (d) =>
                d.draft.authorThreadId === run.threadId &&
                Date.parse(d.draft.createdAt) >= run.startedAt - 5_000,
            )
          ),
      ),
    );
  }, [drafts]);

  const agent = threads.describePageAgent({ page, content: "" } as PagesReadResult);
  const agentLabel = agent
    ? `${PROVIDER_DISPLAY_NAMES[agent.modelSelection.provider] ?? agent.modelSelection.provider} · ${agent.modelSelection.model}`
    : null;

  const aiContext = useMemo(
    () => ({
      aiAvailable: agent !== null && !props.readOnly,
      agentLabel,
      drafts: drafts.map(
        (entry): DeckEditorDraft => ({
          id: entry.draft.id,
          baseRevision: entry.draft.baseRevision,
          summary: entry.draft.summary,
          ops: entry.ops,
          status: "open",
          author: entry.draft.author,
          authorThreadId: entry.draft.authorThreadId,
          ...(agentLabel ? { agentLabel } : {}),
          ...(entry.target ? { target: entry.target } : {}),
        }),
      ),
      running: runs
        .filter((run) => run.status !== "failed")
        .map((run) => ({
          requestId: run.requestId,
          target: run.target,
          instruction: run.instruction,
        })),
    }),
    [agent !== null, agentLabel, drafts, props.readOnly, runs],
  );
  const aiJson = JSON.stringify(aiContext);
  useEffect(() => {
    channel.setAiContext(aiContext);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, aiJson, ready]);

  // ── Runs ───────────────────────────────────────────────────────────────────────────────
  const startRun = useCallback(
    async (
      requestId: string,
      instruction: string,
      target: DeckTarget | null,
      prompt: () => DeckAiTurnPrompt,
    ): Promise<string | null> => {
      setRuns((current) => [
        ...current,
        {
          requestId,
          instruction,
          target,
          threadId: null,
          startedAt: Date.now(),
          status: "starting",
        },
      ]);
      try {
        // The agent reads the saved deck, so unsaved edits are saved first.
        await channel.flush();
        if (!(await latest.current.flush())) throw new Error("请先保存幻灯片，再提出修改请求。");
        const saved: PagesReadResult = {
          page: { ...latest.current.item.page, revision: latest.current.revision() },
          content: "",
        };
        const threadId = await threadsRef.current.startPageAiTurn(
          saved,
          prompt(),
          () => latest.current.account === startAccount.current,
        );
        setRuns((current) =>
          current.map((run) =>
            run.requestId === requestId ? { ...run, threadId, status: "running" } : run,
          ),
        );
        return threadId;
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : "无法交给 Moss 处理";
        setRuns((current) => current.filter((run) => run.requestId !== requestId));
        toastManager.add({ type: "error", title: "修改请求没有发出", description: message });
        return null;
      }
    },
    [channel],
  );

  const requestChange = useCallback(
    (input: {
      requestId?: string;
      instruction: string;
      target: DeckTarget;
      mode?: "change" | "ask";
    }) => {
      const requestId = input.requestId ?? crypto.randomUUID();
      return startRun(requestId, input.instruction, input.target, () =>
        deckChangePrompt({
          page: { ...latest.current.item.page, revision: latest.current.revision() },
          deck: latest.current.deck,
          instruction: input.instruction,
          target: input.target,
          view: view.current,
          mode: input.mode ?? "change",
        }),
      );
    },
    [startRun],
  );

  // ── Comments ───────────────────────────────────────────────────────────────────────────
  const commentsKey = deckCommentsKey(page.id);
  const comments = usePageComments(commentsKey);
  const identity = useCurrentAccountIdentity();
  const me: PageCommentAuthor = useMemo(
    () =>
      identity.kind === "authenticated" || identity.kind === "saved"
        ? { name: identity.label, initials: identity.initials }
        : { name: "我", initials: pageCommentInitials("我") },
    [identity],
  );
  const meRef = useRef(me);
  meRef.current = me;
  const canAsk = useRef(false);
  canAsk.current = agent !== null && !props.readOnly;
  useEffect(() => {
    channel.setComments(deckCommentThreads(comments));
  }, [channel, comments, ready]);
  /** A comment sent to Moss is a change request aimed at what it is pinned to. */
  const askFromComment = useCallback(
    (body: string, anchor: { slideId: string; elementId?: string }) =>
      requestChange({
        instruction: body,
        target: {
          slideIds: [anchor.slideId],
          elementIds: anchor.elementId ? [anchor.elementId] : [],
        },
        mode: /[?？]\s*$/u.test(body) ? "ask" : "change",
      }),
    [requestChange],
  );

  // 新建幻灯片 → 让 Moss 生成: run the queued request once this deck is open.
  useEffect(() => {
    const prompt = takeDeckGeneration(page.id);
    if (!prompt) return;
    void startRun(crypto.randomUUID(), prompt, null, () =>
      deckGeneratePrompt({
        page: { ...latest.current.item.page, revision: latest.current.revision() },
        prompt,
      }),
    );
    // Once per opened deck.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page.id]);

  // Content changes the agent writes straight into a blank deck arrive as new revisions.
  const generating = runs.some((run) => run.target === null && run.status !== "failed");
  useEffect(() => {
    if (!generating) return;
    let changedAt = 0;
    const timer = setInterval(async () => {
      const changed = await latest.current.reloadIfChanged?.();
      if (changed) changedAt = Date.now();
      // The deck has been written and has been quiet for a while: the run is done.
      else if (changedAt && Date.now() - changedAt > 30_000)
        setRuns((current) => current.filter((run) => run.target !== null));
    }, 3_000);
    return () => clearInterval(timer);
  }, [generating]);

  // ── Draft decisions ────────────────────────────────────────────────────────────────────
  const recordResolution = useCallback(
    async (draftIds: string[], action: "accept" | "discard") => {
      if (!draftIds.length) return;
      try {
        if (action === "accept" && !(await latest.current.flush()))
          throw new Error("修改没有保存，请稍后再试。");
        await ensureNativeApi().pages.draftsMutate({
          op: "resolve",
          scopeSpaceId: props.scopeSpaceId,
          pageId: page.id,
          draftIds: draftIds as PageDraft["id"][],
          action,
          ...(action === "accept" ? { revision: latest.current.revision() } : {}),
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: action === "accept" ? "无法接受修改" : "无法放弃修改",
          description: cause instanceof Error ? cause.message : undefined,
        });
      } finally {
        await refreshDrafts();
      }
    },
    [page.id, props.scopeSpaceId, refreshDrafts],
  );

  /** Moss's own accept (viewer mode, or an editor without review): apply, save, record. */
  const acceptHere = useCallback(
    async (ids: string[]) => {
      let deck = latest.current.deck;
      const accepted: string[] = [];
      const failed: string[] = [];
      for (const entry of drafts.filter((d) => ids.includes(d.draft.id))) {
        try {
          deck = applyDeckOps(deck, entry.ops);
          accepted.push(entry.draft.id);
        } catch {
          failed.push(entry.draft.id);
        }
      }
      if (accepted.length) latest.current.onReplace(deck);
      if (failed.length)
        toastManager.add({
          type: "warning",
          title: "有修改无法应用",
          description: "它改到的幻灯片或元素已被删除或改动。可以放弃它，再重新提出请求。",
        });
      await recordResolution(accepted, "accept");
    },
    [drafts, recordResolution],
  );
  const discard = useCallback(
    (ids: string[]) => void recordResolution(ids, "discard"),
    [recordResolution],
  );

  // ── Pictures, export, present ──────────────────────────────────────────────────────────
  /** Stores a picture in 资料库; the deck refers to its durable /api/ preview path. */
  const storeImage = useCallback(
    async (file: { name: string; type: string; data: ArrayBuffer }) => {
      // Raw bytes over HTTP: the WebSocket's 2 MiB message cap stops base64 files of ~1.5 MB.
      const result = await uploadLibraryFiles([
        {
          name: file.name.replace(/^\.+/u, "") || "image.png",
          ...(file.type ? { mimeType: file.type } : {}),
          data: new Blob([file.data], file.type ? { type: file.type } : {}),
        },
      ]);
      const entry = result.items[0];
      if (!entry?.previewPath) throw new Error("图片已上传，但没有可用的预览地址。");
      return { src: entry.previewPath, alt: entry.title };
    },
    [],
  );
  const uploadImage = useCallback(async (): Promise<{ src: string; alt: string } | null> => {
    const file = await pickFile("image/png,image/jpeg,image/webp,image/gif");
    if (!file) return null;
    return storeImage({ name: file.name, type: file.type, data: await file.arrayBuffer() });
  }, [storeImage]);

  const exportAs = useCallback(
    async (
      format: "pptx" | "pdf" | "png" | "html",
      options: {
        slideIds?: string[];
        slideId?: string;
        includeNotes?: boolean;
        fonts?: "current" | "basic";
        quality?: DeckExportQuality;
      } = {},
    ) => {
      const { slideIds, slideId } = options;
      const current = latest.current;
      const title = current.title || "幻灯片";
      try {
        if (format === "pptx") {
          const { exportDeckToPptx } = await import("./slidesPptx");
          const report = await exportDeckToPptx(current.deck, {
            ...(slideIds ? { slideIds } : {}),
            fonts: options.fonts ?? "current",
          });
          downloadBlob(
            new Blob([report.bytes as BlobPart], {
              type: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            }),
            fileName(title, "pptx"),
          );
          if (report.notes.length)
            toastManager.add({
              type: "info",
              title: "已导出 PowerPoint",
              description: report.notes.join(" "),
            });
        } else if (format === "pdf") {
          const { exportDeckToPdf } = await import("./slidesPdf");
          const bytes = await exportDeckToPdf(current.deck, undefined, {
            ...(slideIds ? { slideIds } : {}),
            includeNotes: options.includeNotes === true,
            quality: options.quality ?? "best",
          });
          downloadBlob(
            new Blob([bytes as BlobPart], { type: "application/pdf" }),
            fileName(title, "pdf"),
          );
        } else if (format === "html") {
          const { exportDeckToHtml } = await import("./slidesHtml");
          const html = await exportDeckToHtml(current.deck, title, {
            ...(slideIds ? { slideIds } : {}),
            quality: options.quality ?? "best",
          });
          downloadBlob(
            new Blob([html], { type: "text/html;charset=utf-8" }),
            fileName(title, "html"),
          );
        } else {
          const { exportSlideToPng } = await import("./slidesPdf");
          const id =
            slideId ?? slideIds?.[0] ?? view.current?.slideId ?? current.deck.slides[0]?.id ?? "";
          const bytes = await exportSlideToPng(current.deck, id);
          const index = current.deck.slides.findIndex((slide) => slide.id === id);
          downloadBlob(
            new Blob([bytes as BlobPart], { type: "image/png" }),
            fileName(`${title}-${index + 1}`, "png"),
          );
        }
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: "导出失败",
          description: cause instanceof Error ? cause.message : undefined,
        });
      }
    },
    [],
  );

  const present = useCallback((slideId: string | null, surface: "fullscreen" | "presenter") => {
    const index = Math.max(
      0,
      latest.current.deck.slides.findIndex((slide) => slide.id === slideId),
    );
    setPresenting({ index, surface });
  }, []);

  // ── Editor events ──────────────────────────────────────────────────────────────────────
  const handleEvent = useCallback(
    (event: DeckEditorEvent) => {
      switch (event.event) {
        case "change":
          latest.current.onChange(event.deck);
          if (event.title) latest.current.onTitle(event.title);
          return;
        case "title-change":
          latest.current.onTitle(event.title);
          return;
        case "view-context":
          view.current = event.context;
          return;
        case "ai-request":
          requestChange({
            requestId: event.requestId,
            instruction: event.instruction,
            target: event.target,
            mode: event.mode,
          });
          return;
        case "drafts-resolved": {
          const done = event.draftIds.filter((id) => !event.failed.includes(id));
          void recordResolution(done, event.action);
          if (event.failed.length)
            toastManager.add({
              type: "warning",
              title: "有修改无法应用",
              description: "它改到的幻灯片或元素已被删除或改动。",
            });
          return;
        }
        case "request-image":
          if (event.mode !== "generate") {
            void (event.file ? storeImage(event.file) : uploadImage()).then(
              (image) =>
                channel.imageResult(
                  image
                    ? { requestId: event.requestId, ok: true, src: image.src, alt: image.alt }
                    : { requestId: event.requestId, ok: false, error: "cancelled" },
                ),
              (cause: unknown) => {
                channel.imageResult({
                  requestId: event.requestId,
                  ok: false,
                  error: cause instanceof Error ? cause.message : "上传失败",
                });
              },
            );
          } else {
            void startRun(
              event.requestId,
              event.prompt ?? "生成图像",
              {
                slideIds: [event.target.slideId],
                elementIds: event.target.elementId ? [event.target.elementId] : [],
              },
              () =>
                deckImagePrompt({
                  page: { ...latest.current.item.page, revision: latest.current.revision() },
                  prompt: event.prompt ?? "",
                  target: event.target,
                  deck: latest.current.deck,
                }),
            );
            // The picture arrives later as a proposed change the person accepts.
            channel.imageResult({ requestId: event.requestId, ok: false, error: "deferred" });
          }
          return;
        case "request-export":
          void exportAs(event.format, {
            ...(event.slideIds ? { slideIds: event.slideIds } : {}),
            ...(event.includeNotes ? { includeNotes: true } : {}),
            ...(event.fonts ? { fonts: event.fonts } : {}),
            ...(event.quality ? { quality: event.quality } : {}),
          });
          return;
        case "copy-slide-link": {
          // 拷贝幻灯片链接: a 资料空间 link that opens this deck on that slide (in chats too).
          const link = spacePageSlideLink(page.id, event.slideNumber);
          void navigator.clipboard
            .writeText(link)
            .then(() => toastManager.add({ type: "success", title: "已拷贝这张幻灯片的链接" }))
            .catch(() =>
              toastManager.add({
                type: "error",
                title: "没能拷贝链接",
                description: "请再试一次。",
              }),
            );
          return;
        }
        case "request-present":
          // The editor presents full screen itself; 演讲者视图 (speaker notes window) is Moss's.
          if (event.surface === "presenter") present(event.startSlideId, "presenter");
          return;
        case "request-share":
          setSharing(true);
          return;
        case "request-history":
        case "request-comments":
          // The editor draws its own comment pins and cards.
          return;
        case "comment-post":
        case "comment-reply":
          postDeckComment({
            pageKey: commentsKey,
            author: meRef.current,
            threadId: event.event === "comment-reply" ? event.threadId : null,
            anchor: event.event === "comment-post" ? event.anchor : null,
            label: event.event === "comment-post" ? event.label : "",
            body: event.body,
            sendToAgent: event.sendToAgent && canAsk.current,
            ask: askFromComment,
          });
          if (event.sendToAgent && !canAsk.current)
            toastManager.add({
              type: "info",
              title: "评论已保存",
              description: "这个幻灯片现在不能交给 Moss 修改。",
            });
          return;
        case "comment-resolve":
          usePageCommentsStore.getState().setResolved(commentsKey, event.threadId, event.resolved);
          return;
        case "comment-delete":
          usePageCommentsStore.getState().deleteComment(commentsKey, event.threadId);
          return;
        case "stop-ai":
          setRuns((current) =>
            event.requestId ? current.filter((run) => run.requestId !== event.requestId) : [],
          );
          return;
        case "thumbnail":
          return;
        case "error":
          setError(event.message);
          return;
      }
    },
    [
      askFromComment,
      channel,
      commentsKey,
      exportAs,
      present,
      recordResolution,
      requestChange,
      startRun,
      storeImage,
      uploadImage,
    ],
  );
  useEffect(() => {
    channel.onEvent = handleEvent;
    return () => {
      channel.onEvent = () => {};
    };
  }, [channel, handleEvent]);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      channel.receive(event.data);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      channel.reset();
    };
  }, [channel, origin]);

  // A slide link (moss://space-page/<id>#slide-N) asked for this deck: open on slide N.
  const [startSlideId] = useState(() => {
    const n = takeStartSlide(page.id);
    return n ? (props.deck.slides[n - 1]?.id ?? null) : null;
  });
  // Load (and reload after an outside replacement: conflict reload or a Moss-side accept).
  useEffect(() => {
    channel.load({
      ...(startSlideId ? { startSlideId } : {}),
      // The same key replaces the deck in place (view, selection and undo are kept).
      documentKey: page.id,
      deck: latest.current.deck,
      title: latest.current.title,
      readOnly: props.readOnly,
      mode: props.readOnly ? "view" : "edit",
      theme: resolvedTheme === "dark" ? "dark" : "light",
      locale: navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en",
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, page.id, props.epoch]);
  useEffect(() => channel.setReadOnly(props.readOnly), [channel, props.readOnly]);
  useEffect(() => {
    if (props.saveState === "saved") channel.saveStatus("saved");
    else if (props.saveState === "failed") channel.saveStatus("error", "保存失败，正在重试");
    else if (props.saveState === "conflict")
      channel.saveStatus("error", "内容在别处被修改，已载入最新版本");
  }, [channel, props.saveState, ready]);
  useEffect(
    () => channel.setPresentation(resolvedTheme === "dark" ? "dark" : "light"),
    [channel, resolvedTheme],
  );

  // No editor answer in time (older Canvas build, missing bundle): Moss's own viewer.
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => {
      if (!channel.isLoaded) setUnavailable(true);
    }, EDITOR_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [channel, ready]);

  const editorReviews = ready && channel.supports("ai-drafts");
  const highlight = useMemo(() => {
    const ids = new Set<string>();
    for (const entry of drafts) {
      try {
        const diff = diffDecks(props.deck, applyDeckOps(props.deck, entry.ops));
        for (const list of Object.values(diff.changedElements)) for (const id of list) ids.add(id);
      } catch {
        /* stale draft */
      }
    }
    return ids;
  }, [drafts, props.deck]);

  return (
    <div
      className="relative flex min-h-0 flex-1 flex-col"
      data-deck-host={unavailable ? "viewer" : ready ? "editor" : "loading"}
    >
      {unavailable || error ? (
        <DeckViewer
          deck={props.deck}
          title={props.title}
          readOnly={props.readOnly}
          notice={error ?? "幻灯片画布编辑器没有加载，正在用 Moss 查看器打开。"}
          drafts={drafts}
          highlight={highlight}
          running={runs}
          aiAvailable={agent !== null && !props.readOnly}
          agentLabel={agentLabel}
          onRequestChange={(instruction, target) => requestChange({ instruction, target })}
          onAccept={(ids) => void acceptHere(ids)}
          onDiscard={discard}
          onPresent={(slideId, surface) => present(slideId, surface)}
          onExport={(format, options) => void exportAs(format, options)}
          onShare={() => setSharing(true)}
          onViewChange={(context) => {
            view.current = context;
          }}
          onRetryEditor={() => {
            setUnavailable(false);
            setError(null);
            channel.reset();
            frame.current?.contentWindow?.location.replace(src);
          }}
        />
      ) : null}
      <iframe
        ref={frame}
        src={src}
        title="幻灯片编辑器"
        allow="fullscreen"
        className={
          unavailable || error ? "hidden" : "min-h-80 w-full flex-1 border-0 bg-background"
        }
        onLoad={() => {
          channel.reset();
          channel.hello();
        }}
      />
      {!ready && !unavailable && !error ? (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center bg-background text-ui-sm text-muted-foreground"
        >
          正在打开幻灯片编辑器…
        </div>
      ) : null}
      {ready && !editorReviews && drafts.length ? (
        <div className="absolute right-4 bottom-4 flex items-center gap-2 rounded-panel border border-border bg-popover px-3 py-2 shadow-md">
          <span className="text-ui-sm">{drafts.length} 处修改建议</span>
          <Button size="xs" onClick={() => void acceptHere(drafts.map((d) => d.draft.id))}>
            全部接受
          </Button>
          <Button size="xs" variant="ghost" onClick={() => discard(drafts.map((d) => d.draft.id))}>
            放弃
          </Button>
        </div>
      ) : null}
      {presenting ? (
        <SlidesPresenter
          deck={props.deck}
          startIndex={presenting.index}
          surface={presenting.surface}
          onClose={() => setPresenting(null)}
        />
      ) : null}
      <DeckCommentAgentReplies pageKey={commentsKey} comments={comments} />
      <PageShareDialog
        open={sharing}
        onOpenChange={setSharing}
        account={props.account}
        scopeSpaceId={props.scopeSpaceId}
        page={page}
        flush={props.flush}
      />
    </div>
  );
}
