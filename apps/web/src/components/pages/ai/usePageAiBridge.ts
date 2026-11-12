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
import { useCallback, useEffect, useMemo, useRef } from "react";

import { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { ensureNativeApi } from "~/nativeApi";
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

const readAsBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error("read failed"));
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/u, ""));
    reader.readAsDataURL(file);
  });

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
) {
  const client = useQueryClient();
  const navigate = useNavigate();
  // useHandleNewThread returns fresh closures every render; read them through a ref so the
  // commands registered for the page chrome stay stable (a changing one re-renders the page).
  const threads = useHandleNewThread();
  const threadsRef = useRef(threads);
  threadsRef.current = threads;
  const latest = useRef(options);
  latest.current = options;
  const page = options?.document.page;
  const key = page ? pageAiKey(options.account, options.scopeSpaceId, page.id) : "";
  const session = usePageAiSession(key);
  const active = session.runs.some(isActiveRun);
  const locale = pageAiLocale();
  const text = pageAiText(locale);

  const drafts = useQuery({
    queryKey: page
      ? pageDraftsQueryKey(options.account, options.scopeSpaceId, page.id)
      : ["page-drafts-disabled"],
    queryFn: () =>
      ensureNativeApi().pages.drafts({ scopeSpaceId: options!.scopeSpaceId, pageId: page!.id }),
    enabled: !!page,
    refetchInterval: active ? 2_500 : 15_000,
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

  const draftList: readonly PageDraft[] = drafts.data?.drafts ?? [];
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

  const startRun = useCallback(
    async (input: { mode: PageAiRunMode; prompt: string; anchorBlockId: string | null }) => {
      const current = latest.current;
      if (!current || !key) return;
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
          pageAiPrompt(input.mode, input.prompt, saved, input.anchorBlockId),
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
      } catch (cause) {
        const message = pageAiErrorText(cause instanceof Error ? cause.message : undefined, text);
        pageAiSession.updateRun(key, id, { status: "failed", error: message });
        toastManager.add({ type: "error", title: text.runFailed, description: message });
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
        const result = await ensureNativeApi().library.importFiles({
          files: [
            {
              name: file.name.replace(/^\.+/u, "") || "file",
              ...(file.type ? { mimeType: file.type } : {}),
              dataBase64: await readAsBase64(file),
            },
          ],
        });
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
      switch (event.event) {
        case "ai-request":
          void startRun({
            mode: event.mode,
            prompt: event.prompt,
            anchorBlockId: event.anchorBlockId,
          });
          return;
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
          if (event.kind === "thread" || event.kind === "chat")
            void current
              .flush()
              .then(() => navigate({ to: "/$threadId", params: { threadId: event.id } }));
          else if (event.kind === "page") current.openPage(event.id as PageId);
          else if (event.kind === "file") current.openFiles();
          else toastManager.add({ type: "info", title: text.appPageSoon });
          return;
      }
    },
    [key, navigate, prepare, resolveDrafts, startRun, text.appPageSoon, upload],
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
    pageAiSession.registerEditor(key, { openAiInput, runInsertItem, startRun, prepare });
    return () => pageAiSession.registerEditor(key, null);
    // focusEditor reads a ref; it does not need to re-register the commands.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, key, prepare, startRun]);

  return { key, runs: session.runs, refreshDrafts };
}
