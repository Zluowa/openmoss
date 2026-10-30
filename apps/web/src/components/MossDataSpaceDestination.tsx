import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import {
  type AutomationDefinition,
  type Page,
  PageId,
  type PagesMutateInput,
  type PagesReadResult,
  type SpaceId,
} from "@synara/contracts";
import { ensureNativeApi } from "~/nativeApi";
import { useTheme } from "~/hooks/useTheme";
import { useMossImagesAccountBoundary } from "~/lib/mossImagesAccountBoundary";
import { pageReadQueryOptions, pagesQueryKeys } from "~/lib/pagesReactQuery";
import { PageEditorSession } from "~/lib/pageEditorSession";
import { PageDraftJournal } from "~/lib/pageDraftJournal";
import { isPageMutationRejected, PageMutationIntent } from "~/lib/pageMutationIntent";
import { downloadBlob } from "~/lib/browserDownload";
import { useStore } from "~/store";
import { useSpacesUiStore } from "~/spacesUiStore";
import { useAutomations } from "~/routes/-automations.shared";
import { AutomationCreateDialog } from "~/routes/-automations.list";
import { Button } from "./ui/button";
import { Dialog, DialogPopup, DialogTitle } from "./ui/dialog";
import { CodeEditorPane } from "./codeEditor/CodeEditorPane";
import { MossPageRichEditor } from "./MossPageRichEditor";
import { DisclosureRegion } from "./ui/DisclosureRegion";
import ChatMarkdown from "./ChatMarkdown";
import { MossLibraryDestination } from "./MossLibraryDestination";
import { SidebarIconButton } from "./SidebarIconButton";
import { SidebarPanelTitle } from "./SidebarPanelTitle";
import { SearchInput } from "./ui/search-input";
import { AddPlusIcon, XIcon } from "~/lib/icons";
import { cn } from "~/lib/utils";
import {
  SIDEBAR_HEADER_ROW_CLASS_NAME,
  SIDEBAR_NESTED_LIST_GAP_CLASS_NAME,
  SIDEBAR_ROW_ACTIVE_CLASS_NAME,
  SIDEBAR_ROW_HOVER_CLASS_NAME,
  SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
  SIDEBAR_SECTION_LABEL_CLASS_NAME,
} from "~/sidebarRowStyles";
import { PAGE_TITLE_CLASS_NAME } from "~/surfaceStyles";

type LibraryProps = Parameters<typeof MossLibraryDestination>[0];
type Props = LibraryProps & {
  onStartPageConversation: (document: PagesReadResult, isCurrent: () => boolean) => Promise<void>;
};
type Section = "all" | "pinned" | "recent" | "personal" | "files" | "trash";
const INPUT =
  "w-full rounded-lg border border-border bg-transparent px-3 py-2 text-ui-sm outline-none focus:ring-2 focus:ring-ring";

/** Data spaces own Pages; the existing Library remains the file/asset surface. */
export function MossDataSpaceDestination(props: Props) {
  const boundary = useMossImagesAccountBoundary();
  const scopeSpaceId = useSpacesUiStore((state) => state.activeSpaceId);
  return boundary.transitioning ? (
    <div role="status">正在切换账号…</div>
  ) : (
    <DataSpaceWorkspace
      key={`${boundary.identityKey}:${scopeSpaceId}`}
      {...props}
      account={boundary.identityKey}
      scopeSpaceId={scopeSpaceId}
      isCurrent={boundary.isCurrent}
    />
  );
}

function DataSpaceWorkspace({
  account,
  scopeSpaceId,
  isCurrent,
  onStartPageConversation,
  ...libraryProps
}: Props & {
  account: string;
  scopeSpaceId: SpaceId | null;
  isCurrent: () => boolean;
}) {
  const client = useQueryClient();
  const [section, setSection] = useState<Section>("all");
  const [selectedId, setSelectedId] = useState<PageId | null>(null);
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState<ReadonlySet<PageId>>(new Set());
  const [createIntent] = useState(
    () =>
      new PageMutationIntent(
        `moss:page-create:${account}:${scopeSpaceId}`,
        (input) =>
          input.scopeSpaceId === scopeSpaceId &&
          (input.op === "create" || input.op === "create-space"),
      ),
  );
  const [create, setCreate] = useState<{ space: boolean; parent: Page | null } | null>(() =>
    createIntent.pending
      ? { space: createIntent.pending.op === "create-space", parent: null }
      : null,
  );
  const [name, setName] = useState(() => {
    const pending = createIntent.pending;
    return pending?.op === "create" || pending?.op === "create-space" ? pending.title : "";
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const leaveGuard = useRef<(() => Promise<boolean>) | null>(null);
  const registerGuard = useCallback(
    (guard: (() => Promise<boolean>) | null) => {
      leaveGuard.current = guard;
      libraryProps.onCanvasLeaveGuardChange?.(guard);
    },
    [libraryProps.onCanvasLeaveGuardChange],
  );
  useEffect(() => () => registerGuard(null), [registerGuard]);

  const spacesQuery = useQuery({
    queryKey: pagesQueryKeys.spaces(account, scopeSpaceId),
    queryFn: () => ensureNativeApi().pages.spaces({ scopeSpaceId }),
    refetchInterval: 5_000,
  });
  const listQuery = useQuery({
    queryKey: pagesQueryKeys.list(account, scopeSpaceId),
    queryFn: () => ensureNativeApi().pages.list({ scopeSpaceId, includeTrashed: true }),
    refetchInterval: 5_000,
  });
  const allPages = listQuery.data?.pages ?? [];
  const pages = allPages.filter((page) => !page.trashedAt);
  const spaces = spacesQuery.data?.spaces ?? [];
  const refresh = useCallback(
    () => client.invalidateQueries({ queryKey: pagesQueryKeys.scope(account, scopeSpaceId) }),
    [account, client, scopeSpaceId],
  );
  const select = async (id: PageId | null, nextSection?: Section) => {
    if (!(await (leaveGuard.current?.() ?? Promise.resolve(true))) || !isCurrent()) return;
    setSelectedId(id);
    if (nextSection) setSection(nextSection);
  };
  const openCreate = async (space: boolean, parent: Page | null = null) => {
    if (!(await (leaveGuard.current?.() ?? Promise.resolve(true))) || !isCurrent()) return;
    if (createIntent.pending) {
      setCreate({ space: createIntent.pending.op === "create-space", parent: null });
      setError("上次创建的结果尚未确认，请核对同一次创建。");
      return;
    }
    setName("");
    setError(null);
    setCreate({ space, parent });
  };
  const createPage = async () => {
    if (!create || !name.trim() || busy || !isCurrent()) return;
    setBusy(true);
    setError(null);
    try {
      const input: PagesMutateInput =
        createIntent.pending ??
        createIntent.remember(
          create.space
            ? {
                op: "create-space",
                requestId: crypto.randomUUID(),
                scopeSpaceId,
                title: name.trim(),
              }
            : {
                op: "create",
                requestId: crypto.randomUUID(),
                scopeSpaceId,
                title: name.trim(),
                spaceId: create.parent?.spaceId ?? null,
                parentPageId: create.parent?.id ?? null,
              },
        );
      const result = await createIntent.submit(input, (pending) =>
        ensureNativeApi().pages.mutate(pending),
      );
      createIntent.clear();
      if (!isCurrent()) return;
      client.setQueryData(pagesQueryKeys.read(account, scopeSpaceId, result.page.id), result);
      if (create.parent) setExpanded((previous) => new Set([...previous, create.parent!.id]));
      setCreate(null);
      setSelectedId(result.page.id);
      setSection("all");
      await refresh();
    } catch (cause) {
      if (isPageMutationRejected(cause)) createIntent.clear();
      if (isCurrent()) setError(cause instanceof Error ? cause.message : "创建失败，请重试。");
    } finally {
      setBusy(false);
    }
  };
  const filteredPages = pages.filter((page) =>
    page.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
  );
  const roots = pages.filter((page) => page.parentPageId === null && page.spaceId === null);
  const renderTree = (page: Page, depth = 0, visited = new Set<PageId>()): ReactNode => {
    if (visited.has(page.id) || depth > 64) return null;
    const next = new Set([...visited, page.id]);
    const children = pages.filter((entry) => entry.parentPageId === page.id);
    return (
      <div key={page.id}>
        <div
          className="flex min-w-0 items-center rounded-lg hover:bg-accent"
          style={{ paddingLeft: `${depth * 12}px` }}
        >
          <button
            className="w-6 shrink-0 py-2 text-muted-foreground"
            aria-label={`${expanded.has(page.id) ? "收起" : "展开"} ${page.title}`}
            disabled={children.length === 0}
            onClick={() =>
              setExpanded((previous) => {
                const value = new Set(previous);
                if (value.has(page.id)) value.delete(page.id);
                else value.add(page.id);
                return value;
              })
            }
          >
            {children.length ? (expanded.has(page.id) ? "⌄" : "›") : "·"}
          </button>
          <button
            className="min-w-0 flex-1 truncate py-2 text-left text-ui-sm"
            aria-current={selectedId === page.id ? "page" : undefined}
            onClick={() => void select(page.id)}
          >
            {page.title}
          </button>
          <button
            className="px-2 text-muted-foreground"
            aria-label={`在 ${page.title} 新建子页面`}
            onClick={() => void openCreate(false, page)}
          >
            +
          </button>
        </div>
        {children.length ? (
          <DisclosureRegion open={expanded.has(page.id)}>
            {children.map((child) => renderTree(child, depth + 1, next))}
          </DisclosureRegion>
        ) : null}
      </div>
    );
  };
  const cards =
    section === "pinned"
      ? filteredPages.filter((page) => page.pinned)
      : section === "personal"
        ? filteredPages.filter((page) => page.spaceId === null)
        : section === "recent"
          ? [...filteredPages].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 30)
          : section === "trash"
            ? allPages.filter(
                (page) =>
                  page.trashedAt &&
                  page.title.toLocaleLowerCase().includes(query.toLocaleLowerCase()),
              )
            : filteredPages;
  const failed = listQuery.error ?? spacesQuery.error;

  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 overflow-hidden" data-moss-data-spaces>
      <aside
        className="flex w-70 shrink-0 flex-col border-r border-[color:var(--app-rail-inset-border,var(--border))] bg-[var(--app-rail-panel-background,var(--sidebar))] max-md:w-52"
        aria-label="资料空间导航"
      >
        <SidebarPanelTitle title="资料空间">
          <SidebarIconButton
            icon={XIcon}
            label="关闭资料空间"
            size="header"
            onClick={libraryProps.onClose}
          />
        </SidebarPanelTitle>
        <div className="px-3">
          <SearchInput
            aria-label="搜索页面"
            placeholder="搜索页面"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              void select(null);
            }}
          />
        </div>
        <nav className={cn("mt-2 flex flex-col px-2", SIDEBAR_NESTED_LIST_GAP_CLASS_NAME)}>
          {(
            [
              ["all", "全部"],
              ["pinned", "置顶"],
              ["recent", "最近"],
              ["personal", "个人"],
              ["files", "资料库文件"],
              ["trash", "回收站"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cn(
                SIDEBAR_HEADER_ROW_CLASS_NAME,
                section === id && !selectedId
                  ? SIDEBAR_ROW_ACTIVE_CLASS_NAME
                  : cn(SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME, SIDEBAR_ROW_HOVER_CLASS_NAME),
              )}
              aria-current={section === id && !selectedId ? "page" : undefined}
              onClick={() => void select(null, id)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="mt-4 flex items-center justify-between pr-2.5 pl-4.5">
          <span className={SIDEBAR_SECTION_LABEL_CLASS_NAME}>资料空间</span>
          <SidebarIconButton
            icon={AddPlusIcon}
            label="新建资料空间"
            onClick={() => void openCreate(true)}
          />
        </div>
        <div className="min-h-0 flex-1 overflow-auto px-2">
          {spaces
            .filter((space) => !space.trashedAt)
            .map((space) => {
              const root = pages.find((page) => page.id === space.rootPageId);
              return root ? renderTree(root) : null;
            })}
          <div className={cn("mt-4 px-2.5", SIDEBAR_SECTION_LABEL_CLASS_NAME)}>个人</div>
          {roots.map((page) => renderTree(page))}
        </div>
        <div className="p-2">
          <button
            type="button"
            className={cn(
              SIDEBAR_HEADER_ROW_CLASS_NAME,
              SIDEBAR_ROW_IDLE_TEXT_CLASS_NAME,
              SIDEBAR_ROW_HOVER_CLASS_NAME,
            )}
            onClick={() => void openCreate(false)}
          >
            <AddPlusIcon aria-hidden className="size-3.5 shrink-0" />
            新建页面
          </button>
        </div>
      </aside>
      <main className="flex min-h-0 min-w-0 flex-1 flex-col" aria-label="资料空间内容">
        {error && !create ? (
          <div role="alert" className="p-3 text-destructive">
            {error}
          </div>
        ) : null}
        {section === "files" ? (
          <MossLibraryDestination {...libraryProps} onCanvasLeaveGuardChange={registerGuard} />
        ) : selectedId ? (
          <PageDocument
            key={selectedId}
            pageId={selectedId}
            account={account}
            scopeSpaceId={scopeSpaceId}
            pages={allPages}
            isCurrent={isCurrent}
            onChanged={refresh}
            onSelect={(id) => void select(id)}
            onCreateChild={(parent) => void openCreate(false, parent)}
            onGuardChange={registerGuard}
            onFiles={() => void select(null, "files")}
            onStartConversation={onStartPageConversation}
          />
        ) : (
          <div className="flex min-h-0 flex-1 flex-col p-6 md:p-10">
            <header className="mb-8 flex flex-wrap items-center justify-between gap-3">
              <div>
                <h1 className={PAGE_TITLE_CLASS_NAME}>
                  {section === "trash"
                    ? "回收站"
                    : section === "pinned"
                      ? "已置顶"
                      : section === "recent"
                        ? "最近页面"
                        : section === "personal"
                          ? "个人"
                          : "资料空间"}
                </h1>
                <p className="mt-2 text-ui-sm text-muted-foreground">
                  页面、子页面和文件，保存在你的 Moss 工作区。
                </p>
              </div>
              <Button onClick={() => void openCreate(false)}>新建页面</Button>
            </header>
            {failed ? (
              <div role="alert">
                <p>{failed.message}</p>
                <Button variant="ghost" onClick={() => void refresh()}>
                  重新加载
                </Button>
              </div>
            ) : listQuery.isLoading || spacesQuery.isLoading ? (
              <p role="status">正在加载…</p>
            ) : cards.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
                <p>
                  {section === "trash" ? "回收站为空" : query ? "没有匹配的页面" : "还没有页面"}
                </p>
                {section !== "trash" ? (
                  <Button variant="ghost" onClick={() => void openCreate(false)}>
                    创建第一个页面
                  </Button>
                ) : null}
              </div>
            ) : (
              <div className="grid auto-rows-max grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-4 overflow-auto">
                {cards.map((page) => (
                  <button
                    key={page.id}
                    className="min-h-28 rounded-xl border border-border p-5 text-left hover:bg-accent"
                    onClick={() => void select(page.id)}
                  >
                    <div className="truncate font-medium">
                      {page.pinned ? "★ " : ""}
                      {page.title}
                    </div>
                    <div className="mt-4 text-ui-xs text-muted-foreground">
                      {page.spaceId
                        ? (spaces.find((space) => space.id === page.spaceId)?.title ?? "资料空间")
                        : "个人"}{" "}
                      · {new Date(page.updatedAt).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
      <Dialog
        open={create !== null}
        onOpenChange={(open) => {
          if (!open && !busy) setCreate(null);
        }}
      >
        <DialogPopup>
          <DialogTitle>
            {create?.space ? "新建资料空间" : create?.parent ? "新建子页面" : "新建个人页面"}
          </DialogTitle>
          <form
            className="mt-4 space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              void createPage();
            }}
          >
            <label className="block text-ui-sm">
              名称
              <input
                autoFocus
                className={`${INPUT} mt-2`}
                maxLength={256}
                value={name}
                disabled={busy || createIntent.pending !== null}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            {error || createIntent.error ? (
              <p role="alert" className="text-destructive">
                {error ?? createIntent.error} 重试会核对同一次创建。
              </p>
            ) : null}
            <Button type="submit" disabled={busy || !name.trim()}>
              {busy ? "正在创建…" : createIntent.pending ? "核对创建结果" : "创建"}
            </Button>
          </form>
        </DialogPopup>
      </Dialog>
    </div>
  );
}

function PageDocument(props: {
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
  onStartConversation: Props["onStartPageConversation"];
}) {
  const read = useQuery(pageReadQueryOptions(props.account, props.scopeSpaceId, props.pageId));
  return read.error && !read.data ? (
    <div role="alert" className="p-8">
      {read.error.message}
      <Button variant="ghost" onClick={() => void read.refetch()}>
        重新加载
      </Button>
    </div>
  ) : !read.data ? (
    <p role="status" className="p-8">
      正在打开页面…
    </p>
  ) : (
    <>
      <div role={read.error ? "alert" : undefined}>
        {read.error ? "页面刷新失败，已保留当前内容和草稿。" : null}
      </div>
      <PageEditor {...props} document={read.data} />
    </>
  );
}

function PageEditor({
  document,
  ...props
}: Parameters<typeof PageDocument>[0] & { document: PagesReadResult }) {
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
  const [editing, setEditing] = useState(true);
  const [sourceEditing, setSourceEditing] = useState(false);
  const richFlush = useRef<(() => Promise<boolean>) | null>(null);
  const richUnavailable = useRef(false);
  const registerRichUnavailable = useCallback((unavailable: boolean) => {
    richUnavailable.current = unavailable;
  }, []);
  const registerRichFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
    richFlush.current = flush;
  }, []);
  const flushPage = useCallback(async () => {
    if (!current.current() || (richFlush.current && !(await richFlush.current()))) return false;
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
  const [panel, setPanel] = useState<"versions" | "comments" | "assets" | "move" | null>(null);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [comment, setComment] = useState("");
  const [targetParent, setTargetParent] = useState("");
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [reloadConfirm, setReloadConfirm] = useState(false);
  const [versionPreview, setVersionPreview] = useState<number | null>(null);
  const requestedEnabled = useRef(true);
  const page = state.document.page;
  const projects = useStore((store) => store.projects);
  const scopedProjects = projects.filter(
    (project) => (project.spaceId ?? null) === props.scopeSpaceId,
  );
  const automation = useAutomations();
  const versions = useQuery({
    queryKey: [...pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), "versions"],
    queryFn: () =>
      ensureNativeApi().pages.versions({ scopeSpaceId: props.scopeSpaceId, pageId: page.id }),
    enabled: panel === "versions",
  });
  const comments = useQuery({
    queryKey: [...pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), "comments"],
    queryFn: () =>
      ensureNativeApi().pages.comments({ scopeSpaceId: props.scopeSpaceId, pageId: page.id }),
    enabled: panel === "comments",
    refetchInterval: 5_000,
  });
  const assets = useQuery({
    queryKey: ["pages-assets", props.account],
    queryFn: () => ensureNativeApi().library.list({}),
    enabled: panel === "assets" || page.assetIds.length > 0,
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
  useEffect(() => {
    props.onGuardChange(leavePage);
    return () => props.onGuardChange(null);
  }, [props.onGuardChange, leavePage]);
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
  const perform = async (operation: (saved: PagesReadResult) => Promise<PagesReadResult>) => {
    if (busy || !current.current() || !(await flushPage())) return;
    setBusy(true);
    setActionError(null);
    try {
      const result = await operation(session.getSnapshot().document);
      if (!current.current()) return;
      session.load(result);
      client.setQueryData(pagesQueryKeys.read(props.account, props.scopeSpaceId, page.id), result);
      await props.onChanged();
    } catch (cause) {
      if (current.current())
        setActionError(cause instanceof Error ? cause.message : "操作失败，请重试。");
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
  const attachedAutomations = automation.data.definitions.filter((definition) =>
    page.automationIds.includes(definition.id),
  );

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-page-id={page.id}>
      <header className="flex flex-wrap items-center gap-2 border-b border-border px-5 py-3 text-ui-sm">
        <div className="min-w-0 flex-1 truncate text-muted-foreground">
          {ancestors.map((ancestor) => (
            <span key={ancestor.id}>
              <button onClick={() => props.onSelect(ancestor.id)}>{ancestor.title}</button> /{" "}
            </span>
          ))}
          {state.title}
        </div>
        <span role="status" className="text-ui-xs text-muted-foreground">
          {state.saving ? "正在保存…" : session.dirty ? "未保存" : "已保存"}
        </span>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
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
          }}
        >
          备份未保存草稿
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !!page.trashedAt}
          onClick={() =>
            void perform((saved) => mutate(saved, { op: "pin", pinned: !saved.page.pinned }))
          }
        >
          {page.pinned ? "取消置顶" : "置顶"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === "versions" ? null : "versions")}
        >
          版本
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setPanel(panel === "comments" ? null : "comments")}
        >
          评论
        </Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || !!page.trashedAt || scopedProjects.length === 0}
          onClick={() =>
            void flushPage().then((saved) => {
              if (saved) setScheduleOpen(true);
            })
          }
        >
          定时任务
        </Button>
      </header>
      {state.error ||
      actionError ||
      session.warning ||
      actionIntent.pending ||
      actionIntent.error ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 border-b border-border bg-destructive/5 p-3 text-ui-sm"
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
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => void reconcileAction()}
            >
              核对操作结果
            </Button>
          ) : (
            <Button size="sm" variant="ghost" onClick={() => void flushPage()}>
              重试保存
            </Button>
          )}
          <Button
            size="sm"
            variant="ghost"
            disabled={actionIntent.pending !== null}
            onClick={() => setReloadConfirm(true)}
          >
            重新载入
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void downloadDraft()}>
            下载草稿
          </Button>
        </div>
      ) : null}
      <div className="flex min-h-0 flex-1">
        <section
          className="flex min-h-0 min-w-0 flex-1 flex-col overflow-auto"
          inert={busy || undefined}
        >
          <div className="mx-auto w-full max-w-4xl px-8 pb-4 pt-10">
            <input
              className="w-full bg-transparent text-3xl font-semibold outline-none"
              aria-label="页面标题"
              maxLength={256}
              value={state.title}
              disabled={!!page.trashedAt}
              onChange={(event) => session.change({ title: event.target.value })}
            />
            <div className="my-5 flex flex-wrap items-center gap-2">
              {page.trashedAt ? (
                <Button
                  size="sm"
                  onClick={() =>
                    void perform((saved) =>
                      mutate(saved, { op: isRoot ? "restore-space" : "restore" }),
                    )
                  }
                >
                  恢复{isRoot ? "资料空间" : "页面"}
                </Button>
              ) : (
                <>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void flushPage().then((saved) => {
                        if (saved) setEditing(!editing);
                      })
                    }
                  >
                    {editing ? "预览" : "编辑"}
                  </Button>
                  {!state.richContent ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() =>
                        void flushPage().then((saved) => {
                          if (saved) setSourceEditing(!sourceEditing);
                        })
                      }
                    >
                      {sourceEditing ? "文档编辑" : "Markdown"}
                    </Button>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => void flushPage()}>
                    保存
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => props.onCreateChild(page)}>
                    + 子页面
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => setPanel(panel === "assets" ? null : "assets")}
                  >
                    关联文件
                  </Button>
                  {!isRoot ? (
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setTargetParent(page.parentPageId ?? "");
                        setPanel("move");
                      }}
                    >
                      移动
                    </Button>
                  ) : null}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void perform(async (saved) => {
                        await props.onStartConversation(saved, props.isCurrent);
                        return saved;
                      })
                    }
                  >
                    在对话中继续
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      void perform((saved) =>
                        mutate(saved, { op: isRoot ? "trash-space" : "trash" }),
                      )
                    }
                  >
                    移到回收站
                  </Button>
                </>
              )}
            </div>
            {page.sourceThreadId ? (
              <button
                className="text-ui-xs text-muted-foreground underline"
                onClick={() =>
                  void perform(async (saved) => {
                    await navigate({
                      to: "/$threadId",
                      params: { threadId: page.sourceThreadId! },
                    });
                    return saved;
                  })
                }
              >
                查看来源对话
              </button>
            ) : null}
            {page.assetIds.length ? (
              <div className="my-3 flex flex-wrap gap-2">
                {page.assetIds.map((id) => (
                  <button
                    key={id}
                    className="rounded border border-border px-2 py-1 text-ui-xs"
                    onClick={props.onFiles}
                  >
                    {assets.data?.items.find((item) => item.id === id)?.title ?? "关联文件"}
                  </button>
                ))}
              </div>
            ) : null}
            {attachedAutomations.length ? (
              <div className="my-3 space-y-1">
                {attachedAutomations.map((definition) => (
                  <button
                    key={definition.id}
                    className="block text-ui-xs text-muted-foreground underline"
                    onClick={() =>
                      void perform(async (saved) => {
                        await navigate({
                          to: "/automations/$automationId",
                          params: { automationId: definition.id },
                        });
                        return saved;
                      })
                    }
                  >
                    {definition.enabled ? "定时" : "已暂停"} · {definition.name}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          {sourceEditing && editing && !page.trashedAt && !state.richContent ? (
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
              readOnly={!editing || !!page.trashedAt}
              onChange={session.change}
              onFlushChange={registerRichFlush}
              onUnavailableChange={registerRichUnavailable}
            />
          )}
        </section>
        {panel ? (
          <aside
            className="w-80 shrink-0 overflow-auto border-l border-border p-5 max-lg:w-60"
            aria-label="页面详情"
          >
            <div className="mb-5 flex justify-between">
              <strong>
                {panel === "versions"
                  ? "版本历史"
                  : panel === "comments"
                    ? "评论"
                    : panel === "assets"
                      ? "关联文件"
                      : "移动页面"}
              </strong>
              <button aria-label="关闭页面详情" onClick={() => setPanel(null)}>
                ×
              </button>
            </div>
            {panel === "versions" ? (
              versions.error ? (
                <p role="alert">{versions.error.message}</p>
              ) : versions.isLoading ? (
                <p role="status">正在加载…</p>
              ) : (
                <div className="space-y-4">
                  {versions.data?.versions.map((version) => (
                    <div
                      key={version.page.revision}
                      className="rounded-lg border border-border p-3 text-ui-xs"
                    >
                      <button
                        className="block font-medium"
                        onClick={() =>
                          setVersionPreview(
                            versionPreview === version.page.revision ? null : version.page.revision,
                          )
                        }
                      >
                        版本 {version.page.revision} · {version.author === "agent" ? "CLI" : "你"}
                      </button>
                      <p className="my-2 text-muted-foreground">
                        {new Date(version.createdAt).toLocaleString()}
                      </p>
                      {versionPreview === version.page.revision ? (
                        <ChatMarkdown text={version.content || "空页面"} cwd={undefined} />
                      ) : null}
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={
                          busy || !!page.trashedAt || version.page.revision === page.revision
                        }
                        onClick={() =>
                          void perform(async (saved) => {
                            const restored = await mutate(saved, {
                              op: "restore-version",
                              revision: version.page.revision,
                            });
                            await versions.refetch();
                            return restored;
                          })
                        }
                      >
                        恢复此版本
                      </Button>
                    </div>
                  ))}
                </div>
              )
            ) : null}
            {panel === "comments" ? (
              <div className="space-y-4">
                {comments.error ? (
                  <p role="alert">{comments.error.message}</p>
                ) : comments.isLoading ? (
                  <p role="status">正在加载…</p>
                ) : comments.data?.comments.length === 0 ? (
                  <p className="text-ui-sm text-muted-foreground">还没有评论</p>
                ) : (
                  <div role="list" aria-label="页面评论" className="space-y-4">
                    {comments.data?.comments.map((entry) => (
                      <div
                        key={entry.id}
                        role="listitem"
                        className="rounded-lg border border-border p-3"
                      >
                        <p className="mb-2 text-ui-xs text-muted-foreground">
                          {entry.author === "agent" ? "CLI" : "你"} ·{" "}
                          {new Date(entry.createdAt).toLocaleString()}
                        </p>
                        <p className="whitespace-pre-wrap text-ui-sm">{entry.content}</p>
                      </div>
                    ))}
                  </div>
                )}
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    void perform(async (saved) => {
                      const result = await mutate(saved, {
                        op: "comment",
                        content: comment.trim(),
                      });
                      setComment("");
                      await comments.refetch();
                      return result;
                    });
                  }}
                >
                  <textarea
                    className={INPUT}
                    aria-label="新评论"
                    placeholder="写下评论"
                    maxLength={10_000}
                    value={comment}
                    onChange={(event) => setComment(event.target.value)}
                    disabled={busy || !!page.trashedAt}
                  />
                  <Button
                    size="sm"
                    className="mt-2"
                    type="submit"
                    disabled={busy || !!page.trashedAt || !comment.trim()}
                  >
                    添加评论
                  </Button>
                </form>
              </div>
            ) : null}
            {panel === "assets" ? (
              assets.error ? (
                <p role="alert">{assets.error.message}</p>
              ) : assets.isLoading ? (
                <p role="status">正在加载…</p>
              ) : (
                <div className="space-y-2">
                  <p className="mb-4 text-ui-xs text-muted-foreground">
                    关联资料库中的真实文件。文件仍由资料库管理。
                  </p>
                  {assets.data?.items
                    .filter((item) => !item.trashedAt)
                    .map((item) => (
                      <label key={item.id} className="flex gap-2 text-ui-sm">
                        <input
                          type="checkbox"
                          checked={page.assetIds.includes(item.id)}
                          disabled={busy || !!page.trashedAt}
                          onChange={(event) => {
                            const checked = event.target.checked;
                            void perform((saved) =>
                              mutate(saved, {
                                op: "update",
                                assetIds: checked
                                  ? [...new Set([...saved.page.assetIds, item.id])]
                                  : saved.page.assetIds.filter((id) => id !== item.id),
                              }),
                            );
                          }}
                        />
                        <span className="truncate">{item.title}</span>
                      </label>
                    ))}
                  <Button variant="ghost" size="sm" className="mt-4" onClick={props.onFiles}>
                    打开资料库 / 导入文件
                  </Button>
                </div>
              )
            ) : null}
            {panel === "move" ? (
              <form
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
                <label className="text-ui-sm">
                  移动到
                  <select
                    className={`${INPUT} my-3`}
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
                <Button type="submit" size="sm" disabled={busy}>
                  移动
                </Button>
              </form>
            ) : null}
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
          <p className="my-4 text-ui-sm text-muted-foreground">
            这会放弃当前草稿，读取已保存的最新版本。你也可以先下载草稿。
          </p>
          <Button variant="ghost" onClick={() => void downloadDraft()}>
            下载草稿
          </Button>
          <Button
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
        </DialogPopup>
      </Dialog>
    </div>
  );
}
