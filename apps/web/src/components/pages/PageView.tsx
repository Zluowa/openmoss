// FILE: PageView.tsx
// Purpose: One open 资料空间 page: the top bar (title pill + menu, slots, 历史, 评论, 分享),
//          the document (title, editor), the side panels, and the bottom composer slot.
// Layer: Space page UI
// Why: Save safety is unchanged from the original page editor: every action flushes the
//      editor first, mutations go through a remembered intent so an unknown outcome is checked
//      rather than repeated, and drafts survive in the local journal.

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type AutomationDefinition,
  type Page,
  type PageCover,
  PageId,
  type PagesMutateInput,
  type PagesReadResult,
  type SpaceId,
} from "@moss/contracts";

import { ensureNativeApi, ensurePageSharingApi } from "~/nativeApi";
import { useTheme } from "~/hooks/useTheme";
import { downloadBlob } from "~/lib/browserDownload";
import { XIcon } from "~/lib/icons";
import { PageDraftJournal } from "~/lib/pageDraftJournal";
import { mergePageComments } from "~/lib/pageCommentFeed";
import { PageEditorSession } from "~/lib/pageEditorSession";
import { exportPage, type PageExportFormat } from "~/lib/pageExport";
import { isPageMutationRejected, PageMutationIntent } from "~/lib/pageMutationIntent";
import { pageReadQueryOptions, pagesQueryKeys } from "~/lib/pagesReactQuery";
import { AutomationCreateDialog } from "~/routes/-automations.list";
import { useAutomations } from "~/routes/-automations.shared";
import { useStore } from "~/store";

import { CodeEditorPane } from "../codeEditor/CodeEditorPane";
import { MossPageRichEditor } from "../MossPageRichEditor";
import { SidebarIconButton } from "../SidebarIconButton";
import { spaceKindMeta } from "../space/spaceKinds";
import { Button } from "../ui/button";
import { Dialog, DialogPopup, DialogTitle } from "../ui/dialog";
import { BottomComposer } from "./chrome/BottomComposer";
import type { PageChromeContext, PageSidePanel } from "./chrome/pageChromeContext";
import { PageTitleMenu } from "./chrome/PageTitleMenu";
import { PageTopBar } from "./chrome/PageTopBar";
import { openPageShare } from "./chrome/TopBarShare";
import { pageSharingQueryKeys } from "./sharing/pageSharing.logic";
import {
  PageActivityPanel,
  PageCommentsPanel,
  PageFilesPanel,
  PageHistoryPanel,
  PageNavigationPanel,
} from "./PageSidePanels";

type Panel = PageSidePanel | "move";

const PANEL_TITLES: Record<Panel, string> = {
  history: "历史",
  comments: "评论",
  activity: "页面动态",
  files: "文件列表",
  navigation: "页面导航",
  move: "移动页面",
};

export interface PageViewProps {
  pageId: PageId;
  account: string;
  scopeSpaceId: SpaceId | null;
  pages: readonly Page[];
  isCurrent: () => boolean;
  onChanged: () => Promise<void>;
  onSelect: (id: PageId) => void;
  onCreateChild: (parent: Page) => void;
  onGuardChange: (guard: (() => Promise<boolean>) | null) => void;
  onFiles: () => void;
  onStartConversation: (document: PagesReadResult, isCurrent: () => boolean) => Promise<void>;
  /** After a duplicate is created, open it. */
  onOpenCreated: (document: PagesReadResult) => void;
  onOpenInNewWindow: (pageId: PageId) => void;
}

export function PageView(props: PageViewProps) {
  const read = useQuery(pageReadQueryOptions(props.account, props.scopeSpaceId, props.pageId));
  return read.error && !read.data ? (
    <div role="alert" className="flex items-center gap-2 p-8 text-ui">
      {read.error.message}
      <Button size="sm" variant="ghost" onClick={() => void read.refetch()}>
        重新加载
      </Button>
    </div>
  ) : !read.data ? (
    <p role="status" className="p-8 text-ui text-muted-foreground">
      正在打开页面…
    </p>
  ) : (
    <>
      {read.error ? (
        <div
          role="alert"
          className="border-b border-border px-4 py-2 text-ui-sm text-muted-foreground"
        >
          页面刷新失败，已保留当前内容和草稿。
        </div>
      ) : null}
      <PageEditor {...props} document={read.data} />
    </>
  );
}

function PageEditor({ document, ...props }: PageViewProps & { document: PagesReadResult }) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const current = useRef(props.isCurrent);
  current.current = props.isCurrent;
  const [actionIntent] = useState(
    () =>
      new PageMutationIntent(
        `moss:page-action:${props.account}:${props.scopeSpaceId}:${document.page.id}`,
        (input) =>
          input.scopeSpaceId === props.scopeSpaceId &&
          "pageId" in input &&
          input.pageId === document.page.id,
      ),
  );
  const [draftJournal] = useState(
    () =>
      new PageDraftJournal(
        `moss:page-draft:${props.account}:${props.scopeSpaceId}:${document.page.id}`,
      ),
  );
  const [session] = useState(() => {
    const editor = new PageEditorSession(
      document,
      (input) => {
        if (!current.current()) return Promise.reject(new Error("账号已变化，请重新打开页面。"));
        return ensureNativeApi().pages.mutate(input);
      },
      (saved) => {
        client.setQueryData(
          pagesQueryKeys.read(props.account, props.scopeSpaceId, saved.page.id),
          saved,
        );
        void props.onChanged();
      },
      draftJournal,
    );
    if (actionIntent.pending || actionIntent.error) editor.pause();
    return editor;
  });
  const state = useSyncExternalStore(session.subscribe, session.getSnapshot);
  const [sourceEditing, setSourceEditing] = useState(false);
  const richFlush = useRef<(() => Promise<boolean>) | null>(null);
  const richUnavailable = useRef(false);
  const titleInput = useRef<HTMLInputElement | null>(null);
  const registerRichUnavailable = useCallback((unavailable: boolean) => {
    richUnavailable.current = unavailable;
  }, []);
  const registerRichFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
    richFlush.current = flush;
  }, []);
  const flushPage = useCallback(async () => {
    if (!current.current()) return false;
    // An editor that never loaded cannot contain unsent edits. The parent still
    // flushes its own draft (including title changes) before any mutation.
    if (!richUnavailable.current && richFlush.current && !(await richFlush.current())) return false;
    if (!current.current()) return false;
    return session.flush();
  }, [session]);
  const leavePage = useCallback(async () => {
    if (!current.current()) return false;
    // A correlated load failure leaves the old document locked in the host.
    // Permit leaving a clean saved document without claiming it was saved.
    if (
      richUnavailable.current &&
      !session.dirty &&
      !session.getSnapshot().saving &&
      !actionIntent.pending &&
      !actionIntent.error
    )
      return true;
    return flushPage();
  }, [actionIntent, flushPage, session]);
  const downloadDraft = async () => {
    const captured = !richFlush.current || (await richFlush.current());
    if (!current.current()) return;
    const draft = session.getSnapshot();
    downloadBlob(
      new Blob([draft.richContent ?? draft.content], {
        type: draft.richContent !== null ? "application/json" : "text/markdown;charset=utf-8",
      }),
      `${draft.title || "页面"}${draft.richContent !== null ? ".page.json" : ".md"}`,
    );
    if (!captured)
      setActionError("无法确认编辑器最新内容，已下载当前保留的草稿。请重试编辑器并再次备份。");
  };
  const backupDrafts = () => {
    try {
      for (const draft of draftJournal.records())
        downloadBlob(
          new Blob([draft.richContent ?? draft.content], {
            type: draft.richContent ? "application/json" : "text/markdown;charset=utf-8",
          }),
          `${draft.title || "未保存草稿"}${draft.richContent ? ".page.json" : ".md"}`,
        );
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "无法读取本机草稿。");
    }
  };
  const [panel, setPanel] = useState<Panel | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [targetParent, setTargetParent] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [editorHeaderSupport, setEditorHeaderSupport] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const requestedEnabled = useRef(true);
  const page = state.document.page;
  const readOnly = page.trashedAt !== null;
  const projects = useStore((store) => store.projects);
  const scopedProjects = projects.filter(
    (project) => (project.spaceId ?? null) === props.scopeSpaceId,
  );
  const automation = useAutomations();
  const comments = useQuery({
    queryKey: [...pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), "comments"],
    queryFn: () =>
      ensureNativeApi().pages.comments({ scopeSpaceId: props.scopeSpaceId, pageId: page.id }),
    enabled: panel === "comments" || panel === "activity",
    refetchInterval: panel === "comments" ? 5_000 : false,
  });
  const shareActivity = useQuery({
    queryKey: pageSharingQueryKeys.activity(props.account, props.scopeSpaceId, page.id),
    queryFn: () =>
      ensurePageSharingApi().activity({ scopeSpaceId: props.scopeSpaceId, pageId: page.id }),
    enabled: panel === "comments" || panel === "activity",
    refetchInterval: panel === "comments" ? 5_000 : false,
  });
  const commentFeed = useMemo(
    () => mergePageComments(comments.data?.comments, shareActivity.data?.comments),
    [comments.data?.comments, shareActivity.data?.comments],
  );
  const localCommentStatus = {
    error: comments.error,
    loading: comments.isPending,
    onRetry: () => void comments.refetch(),
  };
  const shareCommentStatus = {
    error: shareActivity.error,
    loading: shareActivity.isPending,
    onRetry: () => void shareActivity.refetch(),
  };
  const assets = useQuery({
    queryKey: ["pages-assets", props.account],
    queryFn: () => ensureNativeApi().library.list({}),
    enabled: panel === "files" || page.assetIds.length > 0,
  });
  useEffect(() => {
    const existing = session.getSnapshot().document;
    if (
      document.page.revision === existing.page.revision &&
      document.content === existing.content &&
      document.richContent === existing.richContent
    )
      return;
    let active = true;
    void (async () => {
      if ((!richFlush.current || (await richFlush.current())) && active && current.current())
        session.load(document);
    })();
    return () => {
      active = false;
    };
  }, [document, session]);
  const { onGuardChange } = props;
  useEffect(() => {
    onGuardChange(leavePage);
    return () => onGuardChange(null);
  }, [onGuardChange, leavePage]);
  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (session.dirty || session.getSnapshot().saving || actionIntent.pending) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [actionIntent, session]);
  // 页面导航: Ctrl+Shift+E (⌘⇧E on macOS) toggles the navigation panel.
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey) || !event.shiftKey || event.altKey) return;
      if (event.key.toLowerCase() !== "e") return;
      event.preventDefault();
      setPanel((open) => (open === "navigation" ? null : "navigation"));
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);
  const perform = async (operation: (saved: PagesReadResult) => Promise<PagesReadResult>) => {
    if (busy || !current.current() || !(await flushPage())) return false;
    setBusy(true);
    setActionError(null);
    try {
      const result = await operation(session.getSnapshot().document);
      if (!current.current()) return false;
      session.load(result);
      client.setQueryData(pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), result);
      await props.onChanged();
      return true;
    } catch (cause) {
      if (current.current())
        setActionError(cause instanceof Error ? cause.message : "操作失败，请重试。");
      return false;
    } finally {
      setBusy(false);
    }
  };
  const mutate = async (saved: PagesReadResult, operation: Record<string, unknown>) => {
    if (!current.current()) throw new Error("账号已变化，请重新打开页面。");
    const input = actionIntent.remember({
      ...operation,
      requestId: crypto.randomUUID(),
      scopeSpaceId: props.scopeSpaceId,
      pageId: page.id,
      expectedRevision: saved.page.revision,
    } as PagesMutateInput);
    session.pause();
    try {
      const result = await actionIntent.submit(input, (pending) =>
        ensureNativeApi().pages.mutate(pending),
      );
      actionIntent.clear();
      session.resume();
      return result;
    } catch (cause) {
      if (isPageMutationRejected(cause)) {
        actionIntent.clear();
        session.resume();
      }
      throw cause;
    }
  };
  const reconcileAction = async () => {
    if (busy || !current.current() || !actionIntent.pending) return;
    setBusy(true);
    setActionError(null);
    try {
      await actionIntent.submit(actionIntent.pending, (pending) =>
        ensureNativeApi().pages.mutate(pending),
      );
      actionIntent.clear();
      session.resume();
      if (!current.current()) return;
      const latest = await ensureNativeApi().pages.read({
        scopeSpaceId: props.scopeSpaceId,
        pageId: page.id,
      });
      if (!current.current()) return;
      session.load(latest);
      session.resume();
      client.setQueryData(pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), latest);
      await props.onChanged();
    } catch (cause) {
      if (isPageMutationRejected(cause)) {
        actionIntent.clear();
        session.resume();
      }
      if (current.current())
        setActionError(cause instanceof Error ? cause.message : "无法确认上次操作，请稍后核对。");
    } finally {
      setBusy(false);
    }
  };
  const isRoot = page.spaceId !== null && page.rootPageId === page.id;
  const isDescendant = (candidate: Page) => {
    const seen = new Set<PageId>();
    let entry: Page | undefined = candidate;
    while (entry && !seen.has(entry.id)) {
      if (entry.id === page.id) return true;
      seen.add(entry.id);
      entry = props.pages.find((item) => item.id === entry!.parentPageId);
    }
    return false;
  };
  const ancestors = useMemo(() => {
    const result: Page[] = [];
    const seen = new Set<PageId>([page.id]);
    let parent = page.parentPageId;
    while (parent && !seen.has(parent)) {
      seen.add(parent);
      const entry = props.pages.find((item) => item.id === parent);
      if (!entry) break;
      result.unshift(entry);
      parent = entry.parentPageId;
    }
    return result;
  }, [page.id, page.parentPageId, props.pages]);
  const attachedAutomations = automation.data.definitions.filter((definition) =>
    page.automationIds.includes(definition.id),
  );
  const duplicate = async () => {
    if (busy || !current.current() || !(await flushPage())) return;
    setBusy(true);
    setActionError(null);
    try {
      const saved = session.getSnapshot().document;
      const copy = await ensureNativeApi().pages.mutate({
        op: "create",
        requestId: crypto.randomUUID(),
        scopeSpaceId: props.scopeSpaceId,
        title: `${saved.page.title}（副本）`.slice(0, 256),
        ...(saved.richContent !== undefined
          ? { richContent: saved.richContent }
          : { content: saved.content }),
        ...(saved.page.kind ? { kind: saved.page.kind } : {}),
        // A copy of a space's root page is a page inside that space, not a second space.
        spaceId: saved.page.spaceId,
        parentPageId: isRoot ? saved.page.id : saved.page.parentPageId,
        assetIds: saved.page.assetIds,
      });
      if (!current.current()) return;
      await props.onChanged();
      props.onOpenCreated(copy);
    } catch (cause) {
      if (current.current())
        setActionError(cause instanceof Error ? cause.message : "复制失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const download = async (format: PageExportFormat) => {
    const captured = !richFlush.current || (await richFlush.current());
    if (!current.current()) return;
    const snapshot = session.getSnapshot();
    try {
      await exportPage(format, { title: snapshot.title || page.title, markdown: snapshot.content });
      if (!captured) setActionError("无法确认编辑器最新内容，已按最近保存的内容下载。");
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : "下载失败，请重试。");
    }
  };

  const context: PageChromeContext = {
    account: props.account,
    scopeSpaceId: props.scopeSpaceId,
    page,
    document: state.document,
    readOnly,
    isCurrent: props.isCurrent,
    flush: flushPage,
    refresh: props.onChanged,
    activePanel: panel === "move" ? null : panel,
    openPanel: setPanel,
    createChildPage: () => props.onCreateChild(page),
  };
  const openSourceThread = () =>
    void perform(async (saved) => {
      await navigate({ to: "/$threadId", params: { threadId: page.sourceThreadId! } });
      return saved;
    });
  const openAutomation = (automationId: string) =>
    void perform(async (saved) => {
      await navigate({ to: "/automations/$automationId", params: { automationId } });
      return saved;
    });
  const editorDrawsHeader =
    editorHeaderSupport && !(sourceEditing && !readOnly && !state.richContent);
  const editorHeader = {
    title: state.title,
    placeholder: "未命名页面",
    editable: !readOnly,
    crumbs: ancestors.map((ancestor) => ({ id: `page:${ancestor.id}`, label: ancestor.title })),
    links: [
      ...(page.sourceThreadId ? [{ id: "thread", label: "来自对话 · 在对话中继续" }] : []),
      ...page.assetIds.map((id) => ({
        id: `file:${id}`,
        label: assets.data?.items.find((item) => item.id === id)?.title ?? "关联文件",
      })),
      ...attachedAutomations.map((definition: AutomationDefinition) => ({
        id: `automation:${definition.id}`,
        label: `${definition.enabled ? "定时" : "已暂停"} · ${definition.name}`,
      })),
    ],
    icon: page.icon ?? null,
    cover: page.cover ?? null,
    onTitleChange: (title: string) => session.change({ title }),
    onAppearanceChange: (change: { icon?: string | null; cover?: PageCover | null }) =>
      void perform((saved) => mutate(saved, { op: "page-appearance", ...change })),
    onAction: (id: string) => {
      if (id.startsWith("page:")) props.onSelect(id.slice(5) as PageId);
      else if (id === "thread" && page.sourceThreadId) openSourceThread();
      else if (id.startsWith("file:")) setPanel("files");
      else if (id.startsWith("automation:")) openAutomation(id.slice(11));
    },
  };
  const kindMeta = spaceKindMeta(page.kind ?? "page");

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-page-id={page.id}>
      <PageTopBar
        context={context}
        saveState={state.saving ? "saving" : session.dirty ? "dirty" : "saved"}
        titleMenu={
          <PageTitleMenu
            title={state.title}
            icon={kindMeta.icon}
            pinned={page.pinned}
            trashed={readOnly}
            sourceEditing={sourceEditing}
            onNavigation={() => setPanel(panel === "navigation" ? null : "navigation")}
            onShare={openPageShare}
            onTogglePin={() =>
              void perform((saved) => mutate(saved, { op: "pin", pinned: !saved.page.pinned }))
            }
            onRename={() => {
              titleInput.current?.focus();
              titleInput.current?.select();
            }}
            onDuplicate={() => void duplicate()}
            onDownload={(format) => void download(format)}
            onOpenInNewWindow={() =>
              void flushPage().then((saved) => {
                if (saved) props.onOpenInNewWindow(page.id);
              })
            }
            onActivity={() => setPanel("activity")}
            onFiles={() => setPanel("files")}
            onMove={
              isRoot
                ? undefined
                : () => {
                    setTargetParent(page.parentPageId ?? "");
                    setPanel("move");
                  }
            }
            onSchedule={
              scopedProjects.length === 0
                ? undefined
                : () =>
                    void flushPage().then((saved) => {
                      if (saved) setScheduleOpen(true);
                    })
            }
            onContinueInChat={() =>
              void perform(async (saved) => {
                await props.onStartConversation(saved, props.isCurrent);
                return saved;
              })
            }
            onEditSource={
              state.richContent
                ? undefined
                : () =>
                    void flushPage().then((saved) => {
                      if (saved) setSourceEditing(!sourceEditing);
                    })
            }
            onBackupDrafts={backupDrafts}
            onTrash={() =>
              void perform((saved) => mutate(saved, { op: isRoot ? "trash-space" : "trash" }))
            }
          />
        }
      />
      {state.error ||
      actionError ||
      session.warning ||
      actionIntent.pending ||
      actionIntent.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/5 px-4 py-2 text-ui-sm"
        >
          <span className="flex-1">
            {state.error ??
              actionError ??
              actionIntent.error ??
              session.warning ??
              "上次操作的结果尚未确认。已保留原操作，请先核对。"}
          </span>
          {actionIntent.pending ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => void reconcileAction()}
            >
              核对操作结果
            </Button>
          ) : (
            <Button size="xs" variant="ghost" onClick={() => void flushPage()}>
              重试保存
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            disabled={actionIntent.pending !== null}
            onClick={() => setReloadConfirm(true)}
          >
            重新载入
          </Button>
          <Button size="xs" variant="ghost" onClick={() => void downloadDraft()}>
            下载草稿
          </Button>
        </div>
      ) : null}
      {readOnly ? (
        <div className="flex items-center gap-3 border-b border-border bg-[color-mix(in_srgb,var(--foreground)_3%,transparent)] px-4 py-2 text-ui-sm">
          <span className="flex-1">这个页面在回收站中，恢复后才能编辑。</span>
          <Button
            size="xs"
            onClick={() =>
              void perform((saved) => mutate(saved, { op: isRoot ? "restore-space" : "restore" }))
            }
          >
            恢复{isRoot ? "资料空间" : "页面"}
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <section className="flex min-h-0 min-w-0 flex-1 flex-col" inert={busy || undefined}>
          <div className="flex min-h-0 flex-1 flex-col overflow-auto">
            {/* Same centred column as the page editor body (Moss Canvas page-editor.css). The editor
                draws this header itself when it can, so title and body scroll as one page. */}
            {editorDrawsHeader ? null : (
              <div className="mx-auto w-full max-w-[848px] px-14 pt-14 pb-1">
                {ancestors.length ? (
                  <nav
                    aria-label="上级页面"
                    className="mb-2 flex flex-wrap items-center gap-1 text-ui-sm text-muted-foreground"
                  >
                    {ancestors.map((ancestor) => (
                      <span key={ancestor.id} className="flex items-center gap-1">
                        <button
                          type="button"
                          className="hover:text-foreground"
                          onClick={() => props.onSelect(ancestor.id)}
                        >
                          {ancestor.title}
                        </button>
                        /
                      </span>
                    ))}
                  </nav>
                ) : null}
                <input
                  ref={titleInput}
                  className="w-full bg-transparent text-3xl font-semibold outline-none"
                  aria-label="页面标题"
                  placeholder="未命名页面"
                  maxLength={256}
                  value={state.title}
                  disabled={readOnly}
                  onChange={(event) => session.change({ title: event.target.value })}
                />
                {page.sourceThreadId ? (
                  <button
                    type="button"
                    className="mt-2 text-ui-sm text-muted-foreground hover:text-foreground"
                    onClick={openSourceThread}
                  >
                    来自对话 · 在对话中继续
                  </button>
                ) : null}
                {page.assetIds.length ? (
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {page.assetIds.map((id) => (
                      <button
                        key={id}
                        type="button"
                        className="rounded-row border border-border px-2 py-0.5 text-ui-sm hover:bg-accent"
                        onClick={() => setPanel("files")}
                      >
                        {assets.data?.items.find((item) => item.id === id)?.title ?? "关联文件"}
                      </button>
                    ))}
                  </div>
                ) : null}
                {attachedAutomations.length ? (
                  <div className="mt-3 flex flex-col gap-1">
                    {attachedAutomations.map((definition: AutomationDefinition) => (
                      <button
                        key={definition.id}
                        type="button"
                        className="self-start text-ui-sm text-muted-foreground hover:text-foreground"
                        onClick={() => openAutomation(definition.id)}
                      >
                        {definition.enabled ? "定时" : "已暂停"} · {definition.name}
                      </button>
                    ))}
                  </div>
                ) : null}
              </div>
            )}
            {sourceEditing && !readOnly && !state.richContent ? (
              <div className="min-h-80 flex-1 px-8">
                <CodeEditorPane
                  value={state.content}
                  valueVersion={state.version}
                  fileName={`${page.id}.md`}
                  resolvedTheme={resolvedTheme}
                  onChange={(content) => session.change({ content })}
                  onSave={() => void flushPage()}
                />
              </div>
            ) : (
              <MossPageRichEditor
                documentKey={`${props.account}:${props.scopeSpaceId}:${page.id}`}
                content={state.content}
                richContent={state.richContent}
                valueVersion={state.version}
                readOnly={readOnly}
                onChange={session.change}
                onFlushChange={registerRichFlush}
                onUnavailableChange={registerRichUnavailable}
                realtime={{ pageId: page.id, scopeSpaceId: props.scopeSpaceId }}
                onRealtimeRevision={(revision) => {
                  if (revision <= session.getSnapshot().document.page.revision) return;
                  void client.invalidateQueries({
                    queryKey: pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id),
                  });
                  void props.onChanged();
                }}
                onRecoveredCopy={(richContent) => {
                  void ensureNativeApi()
                    .pages.mutate({
                      op: "create",
                      requestId: crypto.randomUUID(),
                      scopeSpaceId: props.scopeSpaceId,
                      title: `${page.title}（本机恢复的修改）`.slice(0, 256),
                      richContent,
                      spaceId: page.spaceId,
                      parentPageId: page.parentPageId ?? (page.spaceId ? page.id : null),
                    })
                    .then(async (copy) => {
                      if (!current.current()) return;
                      await props.onChanged();
                      props.onOpenCreated(copy);
                    })
                    .catch((cause: unknown) =>
                      setActionError(
                        cause instanceof Error ? cause.message : "恢复的修改未能保存，请重试。",
                      ),
                    );
                }}
                ai={{
                  account: props.account,
                  scopeSpaceId: props.scopeSpaceId,
                  document: state.document,
                  isCurrent: props.isCurrent,
                  flush: flushPage,
                  createChildPage: () => props.onCreateChild(page),
                  openPage: props.onSelect,
                  openFiles: () => setPanel("files"),
                }}
                header={editorHeader}
                onHeaderSupportChange={setEditorHeaderSupport}
              />
            )}
          </div>
          <div data-page-slot="bottomComposer">
            <BottomComposer context={context} />
          </div>
        </section>
        {panel ? (
          <aside
            className="flex w-80 shrink-0 flex-col border-l border-border max-lg:w-64"
            aria-label={PANEL_TITLES[panel]}
            data-page-side-panel={panel}
          >
            <div className="flex h-11 shrink-0 items-center justify-between ps-4 pe-2">
              <h2 className="text-ui-lg font-semibold">{PANEL_TITLES[panel]}</h2>
              <SidebarIconButton
                icon={XIcon}
                label={`关闭${PANEL_TITLES[panel]}`}
                size="header"
                onClick={() => setPanel(null)}
              />
            </div>
            <div className="min-h-0 flex-1 overflow-auto px-3 pb-4">
              {panel === "history" ? (
                <PageHistoryPanel
                  account={props.account}
                  scopeSpaceId={props.scopeSpaceId}
                  page={page}
                  busy={busy}
                  onRestore={async (revision) => {
                    await perform((saved) => mutate(saved, { op: "restore-version", revision }));
                  }}
                />
              ) : panel === "comments" ? (
                <PageCommentsPanel
                  comments={commentFeed}
                  localStatus={localCommentStatus}
                  shareStatus={shareCommentStatus}
                  readOnly={readOnly}
                  busy={busy}
                  onReplyGuest={() => openPageShare("activity")}
                  onSubmit={async (content) => {
                    const sent = await perform(async (saved) => {
                      const result = await mutate(saved, { op: "comment", content });
                      await comments.refetch();
                      return result;
                    });
                    return sent;
                  }}
                />
              ) : panel === "activity" ? (
                <PageActivityPanel
                  account={props.account}
                  scopeSpaceId={props.scopeSpaceId}
                  page={page}
                  comments={commentFeed}
                  localStatus={localCommentStatus}
                  shareStatus={shareCommentStatus}
                />
              ) : panel === "files" ? (
                <PageFilesPanel
                  page={page}
                  items={assets.data?.items}
                  error={assets.error}
                  loading={assets.isPending}
                  onRetry={() => void assets.refetch()}
                  busy={busy}
                  onToggle={(itemId, attach) =>
                    void perform((saved) =>
                      mutate(saved, {
                        op: "update",
                        assetIds: attach
                          ? [...new Set([...saved.page.assetIds, itemId])]
                          : saved.page.assetIds.filter((id) => id !== itemId),
                      }),
                    )
                  }
                  onOpenLibrary={props.onFiles}
                />
              ) : panel === "navigation" ? (
                <PageNavigationPanel
                  page={page}
                  pages={props.pages}
                  markdown={state.content}
                  onSelect={props.onSelect}
                />
              ) : (
                <form
                  className="flex flex-col gap-3"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async (saved) => {
                      const result = await mutate(saved, {
                        op: "move",
                        spaceId: saved.page.spaceId,
                        parentPageId: targetParent ? PageId.makeUnsafe(targetParent) : null,
                      });
                      setPanel(null);
                      return result;
                    });
                  }}
                >
                  <label className="flex flex-col gap-2 text-ui">
                    移动到
                    <select
                      className="h-7 w-full rounded-control border border-border bg-transparent px-2 text-ui outline-none focus:ring-2 focus:ring-ring"
                      value={targetParent}
                      onChange={(event) => setTargetParent(event.target.value)}
                    >
                      {page.spaceId === null ? <option value="">个人页面顶层</option> : null}
                      {props.pages
                        .filter(
                          (item) =>
                            !item.trashedAt && item.spaceId === page.spaceId && !isDescendant(item),
                        )
                        .map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.title}
                          </option>
                        ))}
                    </select>
                  </label>
                  <Button type="submit" size="sm" className="self-start" disabled={busy}>
                    移动
                  </Button>
                </form>
              )}
            </div>
          </aside>
        ) : null}
      </div>
      <AutomationCreateDialog
        key={page.id}
        open={scheduleOpen}
        onOpenChange={setScheduleOpen}
        busy={automation.createMutation.isPending}
        creationContextKey={`${props.account}:${props.scopeSpaceId}:page:${page.id}`}
        projectIds={scopedProjects.map((project) => project.id)}
        initialDraft={{
          projectId: scopedProjects[0]?.id ?? "",
          name: `更新 ${page.title}`,
          prompt: `请读取资料空间页面 ${page.id} 的最新内容，再按页面中的要求执行并更新同一页面。请使用已连接的资料空间工具读写，不创建重复页面。`,
          enabled: true,
          mode: "dedicated",
        }}
        sourceThreadId={page.sourceThreadId}
        createAutomation={(input, complete, onError) => {
          if (!current.current()) {
            const error = new Error("账号已变化，请重新打开页面。");
            setActionError(error.message);
            onError?.(error);
            return;
          }
          requestedEnabled.current = input.enabled ?? true;
          // The dialog owns a creation lock until this callback settles. A
          // mutation observer's callbacks disappear when its account unmounts.
          void automation.createMutation
            .mutateAsync({ ...input, enabled: false })
            .then(complete, (cause: unknown) =>
              onError?.(
                cause instanceof Error
                  ? cause
                  : new Error("Could not confirm automation creation."),
              ),
            );
        }}
        onCreated={async (definition: AutomationDefinition) => {
          if (!current.current())
            throw new Error("账号已变化，任务已暂停。请在定时任务中继续处理。");
          const latest = await ensureNativeApi().pages.read({
            scopeSpaceId: props.scopeSpaceId,
            pageId: page.id,
          });
          if (!current.current()) throw new Error("账号已变化，任务保持暂停。");
          if (latest.page.trashedAt) throw new Error("页面已在回收站中，任务保持暂停。");
          const pendingAttach = actionIntent.pending;
          if (
            pendingAttach &&
            (pendingAttach.op !== "update" || !pendingAttach.automationIds?.includes(definition.id))
          )
            throw new Error("请先核对页面的上次操作。");
          const linked =
            pendingAttach?.op === "update"
              ? await mutate(latest, { op: "update", automationIds: pendingAttach.automationIds })
              : latest.page.automationIds.includes(definition.id)
                ? latest
                : await mutate(latest, {
                    op: "update",
                    automationIds: [...latest.page.automationIds, definition.id],
                  });
          if (!current.current()) throw new Error("账号已变化，任务保持暂停。");
          session.load(linked);
          client.setQueryData(
            pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id),
            linked,
          );
          if (requestedEnabled.current) {
            const latestAutomations = await ensureNativeApi().automation.list({});
            if (!current.current()) throw new Error("账号已变化，任务保持暂停。");
            const latestDefinition = latestAutomations.definitions.find(
              (entry) => entry.id === definition.id,
            );
            if (!latestDefinition) throw new Error("任务已不可用，请在定时任务中检查。");
            if (!latestDefinition.enabled)
              await automation.updateMutation.mutateAsync({ id: definition.id, enabled: true });
          }
          if (!current.current()) return;
          await props.onChanged();
        }}
        onManage={(definition) =>
          void navigate({
            to: "/automations/$automationId",
            params: { automationId: definition.id },
          })
        }
      />
      <Dialog open={reloadConfirm} onOpenChange={setReloadConfirm}>
        <DialogPopup>
          <DialogTitle>重新载入页面？</DialogTitle>
          <p className="my-4 text-ui text-muted-foreground">
            这会放弃当前草稿，读取已保存的最新版本。你也可以先下载草稿。
          </p>
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => void downloadDraft()}>
              下载草稿
            </Button>
            <Button
              size="sm"
              disabled={state.saving}
              onClick={() => {
                void ensureNativeApi()
                  .pages.read({ scopeSpaceId: props.scopeSpaceId, pageId: page.id })
                  .then((latest) => {
                    if (!current.current()) return;
                    session.discardAndLoad(latest);
                    setReloadConfirm(false);
                  })
                  .catch((cause: unknown) =>
                    setActionError(cause instanceof Error ? cause.message : "载入失败"),
                  );
              }}
            >
              放弃草稿并载入
            </Button>
          </div>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
