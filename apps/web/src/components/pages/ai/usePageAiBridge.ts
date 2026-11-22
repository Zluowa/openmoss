// FILE: usePageAiBridge.ts
// Purpose: Connects one page editor to Moss's agents: sends the editor its open drafts and the
//          pages / files / chats it may mention, runs the AI requests the editor (or the page
//          chrome) asks for, and records accept / discard decisions on the server.
// Layer: Page AI (web)

import {
  PROVIDER_DISPLAY_NAMES,
  type PageDraft,
  type PageId,
  type PagesReadResult,
  type SpaceId,
  type ThreadId,
} from "@moss/contracts";
import { pageBlockAuthor } from "@moss/shared/pageAi";
import { parsePageRichContent } from "@moss/shared/pageRichContent";
import { useNavigate } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type {
  SpaceCanvasDockController,
  SpaceCanvasSelectionContext,
} from "~/components/space/spaceCanvasDockContract";
import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ensureNativeApi } from "~/nativeApi";
import { uploadPickedLibraryFiles } from "~/lib/libraryUpload";
import { pageAiPrompt } from "~/lib/pageAi/pageAiPrompts";
import {
  createPageAssistantKeeper,
  pageAssistantThreads,
  type PageAssistantKeeper,
} from "~/lib/pageAi/pageAssistantThread";
import {
  isActiveRun,
  pageAiKey,
  pageAiSession,
  streamingDraftOps,
  usePageAiSession,
  type PageAiRunMode,
} from "~/lib/pageAi/pageAiSession";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import type {
  PageEditorAiContext,
  PageEditorAiEvent,
  PageRichEditorChannel,
} from "~/lib/pageRichEditorChannel";
import { newCommandId } from "~/lib/utils";
import { useStore } from "~/store";
import { toastManager } from "../../ui/toast";
import { pageAiErrorText, pageAiText, pageAiLocale } from "./pageAiText";

export interface PageAiLastChange {
  readonly beforeRevision: number;
  readonly revision: number;
}

export interface PageAiHostOptions {
  readonly account: string;
  readonly scopeSpaceId: SpaceId | null;
  /** The saved page; drafts are written against its revision. */
  readonly document: PagesReadResult;
  readonly isCurrent: () => boolean;
  /** Saves pending editor changes; false when they could not be saved. */
  readonly flush: () => Promise<boolean>;
  readonly createChildPage: () => void;
  readonly openPage: (pageId: PageId) => void;
  readonly openFiles: () => void;
  /** Unified 3-state canvas dock attached by Space host (null/absent in standalone). */
  readonly dock?: SpaceCanvasDockController | null;
  /** Suggesting / 建议模式 flag: when false, AI edits can land directly with undo snapshot. */
  readonly suggestMode?: boolean;
  /** Optional host callback invoked when a dock turn settles or undo restores a revision. */
  readonly onRefreshPage?: () => Promise<void> | void;
  readonly onUndoAiChange?: (beforeRevision: number) => Promise<boolean> | boolean | void;
}

export const pageDraftsQueryKey = (account: string, scopeSpaceId: SpaceId | null, pageId: PageId) =>
  [...pagesQueryKeys.read(account, scopeSpaceId, pageId), "drafts"] as const;

const blockAuthorThreads = (document: PagesReadResult): string[] => {
  if (!document.richContent) return [];
  try {
    return [
      ...new Set(
        parsePageRichContent(document.richContent)
          .nodes.map((node) => pageBlockAuthor(node)?.threadId)
          .filter((id): id is string => !!id),
      ),
    ];
  } catch {
    return [];
  }
};

const pickFile = (accept: string) =>
  new Promise<File | null>((resolve) => {
    const input = window.document.createElement("input");
    input.type = "file";
    input.accept = accept;
    input.onchange = () => resolve(input.files?.[0] ?? null);
    input.click();
  });

export function usePageAiBridge(
  channel: PageRichEditorChannel,
  options: PageAiHostOptions | null,
  /** Moves keyboard focus into the editor frame; menus and cards there open only when focused. */
  focusEditor: () => void = () => {},
  dockOverride: SpaceCanvasDockController | null = null,
) {
  const client = useQueryClient();
  const navigate = useNavigate();
  // useHandleNewThread returns fresh closures every render; read them through a ref so the
  // commands registered for the page chrome stay stable (a changing one re-renders the page).
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const dock = options?.dock ?? dockOverride ?? null;
  const dockRef = useRef(dock);
  dockRef.current = dock;
  const focusEditorRef = useRef(focusEditor);
  focusEditorRef.current = focusEditor;
  const latest = useRef(options);
  latest.current = options;
  const page = options?.document.page;
  const key = page ? pageAiKey(options.account, options.scopeSpaceId, page.id) : "";
  const session = usePageAiSession(key);
  const active = session.runs.some(isActiveRun);
  const dockBusy = Boolean(dock?.busy);
  const aiBusy = active || dockBusy;
  const locale = pageAiLocale();
  const text = pageAiText(locale);
  const [lastAiChange, setLastAiChange] = useState<PageAiLastChange | null>(null);
  const aiBaselineRef = useRef<{ pageId: string; beforeRevision: number } | null>(null);

  const drafts = useQuery({
    queryKey: page
      ? pageDraftsQueryKey(options.account, options.scopeSpaceId, page.id)
      : ["page-drafts-disabled"],
    queryFn: () =>
      ensureNativeApi().pages.drafts({ scopeSpaceId: options!.scopeSpaceId, pageId: page!.id }),
    enabled: !!page,
    refetchInterval: aiBusy ? 2_500 : 15_000,
  });
  const pages = useQuery({
    queryKey: options
      ? pagesQueryKeys.list(options.account, options.scopeSpaceId)
      : ["pages-disabled"],
    queryFn: () => ensureNativeApi().pages.list({ scopeSpaceId: options!.scopeSpaceId }),
    enabled: !!options,
  });
  const files = useQuery({
    queryKey: ["pages-assets", options?.account ?? ""],
    queryFn: () => ensureNativeApi().library.list({}),
    enabled: !!options,
    staleTime: 60_000,
  });
  const agent = options ? threads.describePageAgent(options.document) : null;
  const agentLabel = agent
    ? `${PROVIDER_DISPLAY_NAMES[agent.modelSelection.provider] ?? agent.modelSelection.provider} · ${agent.modelSelection.model}`
    : null;

  // An outdated draft touched only blocks the person changed since; nothing of it applies.
  const draftList: readonly PageDraft[] = useMemo(
    () => (drafts.data?.drafts ?? []).filter((draft) => !draft.outdated),
    [drafts.data],
  );
  const threadIds = useMemo(
    () => [
      ...new Set([
        ...draftList.map((draft) => draft.authorThreadId).filter((id): id is ThreadId => !!id),
        ...(options ? blockAuthorThreads(options.document) : []),
        ...session.runs.map((run) => run.threadId).filter((id): id is ThreadId => !!id),
      ]),
    ],
    [draftList, options?.document, session.runs],
  );
  const threadTitles = useStore(
    useCallback(
      (state) =>
        JSON.stringify(
          Object.fromEntries(
            threadIds.map((id) => [
              id,
              state.threadShellById?.[id as ThreadId]?.title ?? text.untitledChat,
            ]),
          ),
        ),
      [threadIds, text.untitledChat],
    ),
  );
  const recentChats = useStore(
    useCallback(
      (state) =>
        JSON.stringify(
          Object.values(state.threadShellById ?? {})
            .filter((thread) => !thread.archivedAt)
            .sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt))
            .slice(0, 50)
            .map((thread) => ({ id: thread.id, title: thread.title || text.untitledChat })),
        ),
      [text.untitledChat],
    ),
  );

  const context = useMemo<PageEditorAiContext | null>(() => {
    if (!options || !page) return null;
    const editorDrafts = [
      ...draftList.map((draft) => ({
        id: draft.id,
        status: "open" as const,
        kind: draft.kind,
        summary: draft.summary,
        authorThreadId: draft.authorThreadId,
        ops: draft.ops,
      })),
      // A 生成 reply shows in the page while the agent is still writing it.
      ...session.runs
        .filter((run) => run.mode === "generate" && isActiveRun(run))
        .map((run) => ({
          id: `stream:${run.id}`,
          status: "streaming" as const,
          kind: "text" as const,
          summary: run.prompt.slice(0, 120),
          authorThreadId: run.threadId,
          ops: streamingDraftOps(run),
        })),
    ];
    return {
      locale,
      aiAvailable: agent !== null,
      agentLabel,
      drafts: editorDrafts,
      threads: JSON.parse(threadTitles) as Record<string, string>,
      refs: {
        pages: (pages.data?.pages ?? [])
          .filter((entry) => entry.id !== page.id)
          .slice(0, 200)
          .map((entry) => ({ id: entry.id, title: entry.title })),
        files: (files.data?.items ?? [])
          .slice(0, 200)
          .map((item) => ({ id: item.id, title: item.title })),
        chats: JSON.parse(recentChats) as { id: string; title: string }[],
      },
    };
  }, [
    agent !== null,
    agentLabel,
    draftList,
    files.data,
    locale,
    options,
    page,
    pages.data,
    recentChats,
    session.runs,
    threadTitles,
  ]);
  const contextJson = context ? JSON.stringify(context) : "";
  useEffect(() => {
    if (context) channel.setAiContext(context);
    // The JSON string is the change signal; the object is rebuilt on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, contextJson]);

  // The page's assistant chat keeps its agent started while the page is in use, and stops
  // it after a quiet spell or when the page closes (never under a running turn).
  const keeper = useRef<PageAssistantKeeper | null>(null);
  useEffect(() => {
    if (!key) return;
    const next = createPageAssistantKeeper({
      warm: (threadId) => threadsRef.current.warmPageAssistant(threadId),
      release: (threadId) => threadsRef.current.releasePageAssistant(threadId),
      isBusy: (threadId) => {
        const summary = useStore.getState().sidebarThreadSummaryById[threadId];
        return (
          summary?.session?.orchestrationStatus === "starting" ||
          summary?.session?.orchestrationStatus === "running" ||
          summary?.latestTurn?.state === "running" ||
          pageAiSession.get(key).runs.some((run) => run.threadId === threadId && isActiveRun(run))
        );
      },
    });
    keeper.current = next;
    return () => {
      next.dispose();
      if (keeper.current === next) keeper.current = null;
    };
  }, [key]);
  const preparing = useRef(false);
  const prepare = useCallback(() => {
    const current = latest.current;
    if (!current || !key || preparing.current) return;
    const known = pageAssistantThreads.get(key);
    if (known && useStore.getState().sidebarThreadSummaryById[known]) {
      keeper.current?.warm(known);
      return;
    }
    preparing.current = true;
    void threadsRef.current
      .preparePageAssistant(
        current.document,
        current.isCurrent,
        key,
        text.pageChatTitle(current.document.page.title),
      )
      .then((threadId) => {
        if (threadId) keeper.current?.warm(threadId);
      })
      .finally(() => {
        preparing.current = false;
      });
  }, [key, text]);

  const refreshDrafts = useCallback(() => {
    const current = latest.current;
    if (!current) return Promise.resolve();
    return client.invalidateQueries({
      queryKey: pageDraftsQueryKey(current.account, current.scopeSpaceId, current.document.page.id),
    });
  }, [client]);

  const savedRevision = options?.document.page.revision;

  const dockSetSelection = dock?.setSelection;
  useEffect(() => {
    if (!page || !dockSetSelection) return;
    dockSetSelection({
      kind: "page",
      itemId: page.id,
      title: page.title,
    });
  }, [dockSetSelection, page?.id, page?.title]);

  useEffect(() => {
    setLastAiChange(null);
    aiBaselineRef.current = null;
  }, [page?.id]);

  useEffect(() => {
    if (!page) {
      aiBaselineRef.current = null;
      return;
    }
    if (aiBusy) {
      if (!aiBaselineRef.current || aiBaselineRef.current.pageId !== page.id) {
        aiBaselineRef.current = { pageId: page.id, beforeRevision: page.revision };
      }
      return;
    }
  }, [aiBusy, page?.id, page?.revision]);

  const prevDockBusyRef = useRef(dockBusy);
  useEffect(() => {
    const wasBusy = prevDockBusyRef.current;
    prevDockBusyRef.current = dockBusy;
    if (!wasBusy || dockBusy) return;
    const current = latest.current;
    if (!current) return;
    void refreshDrafts();
    void client.invalidateQueries({
      queryKey: pagesQueryKeys.read(
        current.account,
        current.scopeSpaceId,
        current.document.page.id,
      ),
    });
    void current.onRefreshPage?.();
  }, [client, dockBusy, refreshDrafts]);

  useEffect(() => {
    if (!page) return;
    const baseline = aiBaselineRef.current;
    if (
      baseline &&
      baseline.pageId === page.id &&
      page.revision > baseline.beforeRevision &&
      !options?.suggestMode
    ) {
      setLastAiChange({
        beforeRevision: baseline.beforeRevision,
        revision: page.revision,
      });
      if (!aiBusy) aiBaselineRef.current = null;
    }
  }, [aiBusy, options?.suggestMode, page?.id, page?.revision]);

  const undoAiChange = useCallback(async (): Promise<boolean> => {
    const current = latest.current;
    if (!current || !lastAiChange) return false;
    try {
      if (current.onUndoAiChange) {
        const result = await current.onUndoAiChange(lastAiChange.beforeRevision);
        if (result === false) return false;
      } else {
        if (!(await current.flush())) return false;
        const latestDoc = latest.current?.document ?? current.document;
        await ensureNativeApi().pages.mutate({
          op: "restore-version",
          requestId: newCommandId(),
          scopeSpaceId: current.scopeSpaceId,
          pageId: current.document.page.id,
          expectedRevision: latestDoc.page.revision,
          revision: lastAiChange.beforeRevision,
        });
        await current.onRefreshPage?.();
      }
      setLastAiChange(null);
      aiBaselineRef.current = null;
      await client.invalidateQueries({
        queryKey: pagesQueryKeys.read(
          current.account,
          current.scopeSpaceId,
          current.document.page.id,
        ),
      });
      await refreshDrafts();
      return true;
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: text.resolveFailed,
        description: cause instanceof Error ? cause.message : undefined,
      });
      return false;
    }
  }, [client, lastAiChange, refreshDrafts, text.resolveFailed]);

  // A save of the page re-reads its drafts at once, so a suggestion never lingers over blocks
  // the person just changed (the server leaves those changes out).
  useEffect(() => {
    if (savedRevision !== undefined) void refreshDrafts();
  }, [refreshDrafts, savedRevision]);

  const startRun = useCallback(
    async (input: {
      mode: PageAiRunMode;
      prompt: string;
      anchorBlockId: string | null;
      quote?: string;
    }): Promise<ThreadId | null> => {
      const current = latest.current;
      if (!current || !key) return null;
      const id = newCommandId();
      pageAiSession.addRun(key, {
        id,
        mode: input.mode,
        prompt: input.prompt,
        threadId: null,
        anchorBlockId: input.anchorBlockId,
        baseRevision: current.document.page.revision,
        status: "starting",
        startedAt: Date.now(),
      });
      try {
        // The agent reads the saved page, so unsaved edits are saved first.
        if (!(await current.flush())) throw new Error(text.saveFirst);
        const saved = latest.current?.document ?? current.document;
        const { threadId, baselineTurnId } = await threadsRef.current.startPageAssistantTurn(
          saved,
          pageAiPrompt(input.mode, input.prompt, saved, input.anchorBlockId, input.quote),
          current.isCurrent,
          key,
          text.pageChatTitle(saved.page.title),
        );
        keeper.current?.touch(threadId);
        pageAiSession.updateRun(key, id, {
          threadId,
          baselineTurnId,
          status: "running",
          baseRevision: saved.page.revision,
        });
        return threadId;
      } catch (cause) {
        const message = pageAiErrorText(cause instanceof Error ? cause.message : undefined, text);
        pageAiSession.updateRun(key, id, { status: "failed", error: message });
        toastManager.add({ type: "error", title: text.runFailed, description: message });
        return null;
      }
    },
    [key, text],
  );

  const resolveDrafts = useCallback(
    async (draftIds: string[], action: "accept" | "discard") => {
      const current = latest.current;
      if (!current) return;
      const ids = draftIds.filter((id) => !id.startsWith("stream:"));
      if (!ids.length) return;
      try {
        // An accepted draft is already in the editor; it counts once the page is saved.
        if (action === "accept" && !(await current.flush())) throw new Error(text.saveFirst);
        const revision = latest.current?.document.page.revision;
        await ensureNativeApi().pages.draftsMutate({
          op: "resolve",
          scopeSpaceId: current.scopeSpaceId,
          pageId: current.document.page.id,
          draftIds: ids as PageDraft["id"][],
          action,
          ...(action === "accept" && revision ? { revision } : {}),
        });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: text.resolveFailed,
          description: cause instanceof Error ? cause.message : undefined,
        });
      } finally {
        await refreshDrafts();
      }
    },
    [refreshDrafts, text.resolveFailed, text.saveFirst],
  );

  const upload = useCallback(
    async (kind: "image" | "file", anchorBlockId: string | null) => {
      const file = await pickFile(kind === "image" ? "image/*" : "*/*");
      if (!file) return;
      try {
        // Raw bytes over HTTP: the WebSocket's 2 MiB message cap stops base64 files of ~1.5 MB.
        const result = await uploadPickedLibraryFiles([
          new File([file], file.name.replace(/^\.+/u, "") || "file", { type: file.type }),
        ]);
        const item = result.items[0];
        if (!item?.previewPath) throw new Error(text.uploadNoPreview);
        channel.insertMedia({ kind, url: item.previewPath, name: item.title, anchorBlockId });
      } catch (cause) {
        toastManager.add({
          type: "error",
          title: text.uploadFailed,
          description: cause instanceof Error ? cause.message : undefined,
        });
      }
    },
    [channel, text.uploadFailed, text.uploadNoPreview],
  );

  const handleEvent = useCallback(
    (event: PageEditorAiEvent) => {
      const current = latest.current;
      if (!current) return;
      const activeDock = dockRef.current;
      switch (event.event) {
        case "ai-request":
          void startRun({
            mode: event.mode,
            prompt: event.prompt,
            anchorBlockId: event.anchorBlockId,
          });
          return;
        case "ask-dock": {
          const prompt = event.prompt?.trim() ?? "";
          if (!aiBaselineRef.current || aiBaselineRef.current.pageId !== current.document.page.id) {
            aiBaselineRef.current = {
              pageId: current.document.page.id,
              beforeRevision: current.document.page.revision,
            };
          }
          if (activeDock) {
            const selection: SpaceCanvasSelectionContext = {
              kind: "page",
              itemId: current.document.page.id,
              title: current.document.page.title,
              ...(event.anchorBlockId !== undefined ? { anchorBlockId: event.anchorBlockId } : {}),
              ...(event.quote !== undefined ? { quote: event.quote } : {}),
            };
            activeDock.setSelection(selection);
            void activeDock.ask({
              ...(prompt ? { prompt, autoRun: true } : { prefillOnly: true }),
              preferredState: activeDock.state === "collapsed" ? "pip" : activeDock.state,
              selection,
              keepItemOpen: true,
              origin: "editor-bridge",
            });
          } else if (prompt) {
            void startRun({
              mode: "prompt",
              prompt,
              anchorBlockId: event.anchorBlockId ?? null,
              ...(event.quote ? { quote: event.quote } : {}),
            });
          } else {
            focusEditorRef.current();
            channel.openAiInput("generate");
          }
          return;
        }
        case "drafts-resolved":
          void resolveDrafts(event.draftIds, event.action);
          return;
        case "request-subpage":
          current.createChildPage();
          return;
        case "request-upload":
          void upload(event.kind, event.anchorBlockId);
          return;
        case "ai-input-changed":
          if (key) pageAiSession.setOpenCard(key, event.mode);
          if (event.mode) prepare();
          return;
        case "open-ref":
          if (event.kind === "thread" || event.kind === "chat") {
            if (activeDock) {
              void current.flush().then(() => {
                if (activeDock.state === "collapsed") activeDock.setState("pip");
                const titles = JSON.parse(threadTitles) as Record<string, string>;
                const title = titles[event.id];
                activeDock.openSideChatTab(title ? { title } : undefined);
              });
              return;
            }
            void current
              .flush()
              .then(() => navigate({ to: "/$threadId", params: { threadId: event.id } }));
            return;
          }
          if (event.kind === "page") current.openPage(event.id as PageId);
          else if (event.kind === "file") current.openFiles();
          else
            void current
              .flush()
              .then(() => navigate({ to: "/apps/$appId", params: { appId: event.id } }));
          return;
      }
    },
    [channel, key, navigate, prepare, resolveDrafts, startRun, threadTitles, upload],
  );
  useEffect(() => {
    channel.onAiEvent = handleEvent;
    return () => {
      channel.onAiEvent = () => {};
    };
  }, [channel, handleEvent]);

  useEffect(() => {
    if (!key) return;
    const openAiInput: typeof channel.openAiInput = (mode) => {
      focusEditor();
      channel.openAiInput(mode);
    };
    const runInsertItem = (value: string) => {
      focusEditor();
      channel.runInsertItem(value);
    };
    const openComment = (threadId: string) => channel.openComment(threadId);
    const openFind = (replace: boolean) => {
      focusEditor();
      channel.openFind(replace);
    };
    const insertText = (text: string) => {
      focusEditor();
      channel.insertText(text);
    };
    pageAiSession.registerEditor(key, {
      openAiInput,
      runInsertItem,
      startRun,
      prepare,
      openComment,
      openFind,
      insertText,
      setSuggesting: (on: boolean) => channel.setSuggesting(on),
    });
    return () => pageAiSession.registerEditor(key, null);
    // focusEditor reads a ref; it does not need to re-register the commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, prepare, startRun]);

  return {
    key,
    runs: session.runs,
    refreshDrafts,
    startRun,
    agentReady: !!agent,
    aiBusy,
    suggestMode: options?.suggestMode ?? false,
    lastAiChange,
    undoAiChange,
  };
}
