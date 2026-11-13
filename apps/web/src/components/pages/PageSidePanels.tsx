// FILE: PageSidePanels.tsx
// Purpose: The panels a page opens to its right: 历史 (versions), 评论, 页面动态 (who changed
//          what, with comments), 文件列表 (linked Library files) and 页面导航 (outline and
//          subpages).
// Layer: Space page UI
// Why the history list asks for summaries: a rich page with pictures can be megabytes per
//      version, and the old panel waited for 30 full bodies before it drew anything — the
//      "正在加载…" that never finished. The list is metadata only, 20 at a time; one version's
//      body is read when it is opened.

import { useEffect, useMemo, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { LibraryItem, Page, PageId, PageVersion, SpaceId } from "@moss/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { useTranslation } from "~/localization";
import type { PageCommentFeedItem } from "~/lib/pageCommentFeed";
import type { PageComment } from "~/pageCommentsStore";
import { pagesQueryKeys } from "~/lib/pagesReactQuery";
import { diffPageLines, historyDayLabel } from "~/lib/pageVersionDiff";
import { cn } from "~/lib/utils";

import ChatMarkdown from "../ChatMarkdown";
import { formatRelativeTime } from "../space/spaceItems";
import { Button } from "../ui/button";
import { guestCommentAuthorLabel } from "./sharing/pageSharing.logic";

const HISTORY_PAGE_SIZE = 20;
/** After this long without an answer the panel offers a retry instead of spinning forever. */
const STALLED_AFTER_MS = 12_000;

const OPERATION_LABELS: Record<string, string> = {
  create: "创建了页面",
  "create-space": "创建了资料空间",
  update: "编辑了内容",
  move: "移动了页面",
  pin: "更改了置顶",
  trash: "移到回收站",
  "trash-space": "把资料空间移到回收站",
  restore: "从回收站恢复",
  "restore-space": "恢复了资料空间",
  "restore-version": "恢复了旧版本",
  comment: "添加了评论",
};

export function operationLabel(operation: string): string {
  return OPERATION_LABELS[operation] ?? "更新了页面";
}

function authorLabel(author: PageVersion["author"], guestLabel: string): string {
  return author === "guest" ? guestLabel : author === "agent" ? "助手" : "你";
}

function versionActivity(version: PageVersion, translation: ReturnType<typeof useTranslation>) {
  if (!version.contributors) {
    const author = authorLabel(version.author, translation.t("chat.guestShare.guestFallbackName"));
    return `${author} ${operationLabel(version.operation)} · ${translation.t("page.history.legacySources")}`;
  }
  const keys = {
    "local-user": "page.history.localSource",
    agent: "page.history.agentSource",
    guest: "page.history.guestSource",
    unrecorded: "page.history.unrecordedSource",
  } as const;
  const categories = Array.from(new Set(version.contributors.map((source) => source.kind)));
  const sources = new Intl.ListFormat(translation.locale, {
    style: "short",
    type: "conjunction",
  }).format(categories.map((category) => translation.t(keys[category])));
  if (categories.length === 1 && categories[0] === "unrecorded") return sources;
  return translation.format(
    version.contributors.length > 1
      ? "page.history.collaborativeSources"
      : "page.history.editedBySource",
    { sources },
  );
}

function useStalled(active: boolean): boolean {
  const [stalled, setStalled] = useState(false);
  useEffect(() => {
    if (!active) {
      setStalled(false);
      return;
    }
    const timer = window.setTimeout(() => setStalled(true), STALLED_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [active]);
  return stalled;
}

export function useVersionSummaries(input: {
  account: string;
  scopeSpaceId: SpaceId | null;
  pageId: PageId;
  revision: number;
  enabled: boolean;
}) {
  return useInfiniteQuery({
    queryKey: [
      ...pagesQueryKeys.read(input.account, input.scopeSpaceId, input.pageId),
      "version-summaries",
      input.revision,
    ],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      ensureNativeApi().pages.versions({
        scopeSpaceId: input.scopeSpaceId,
        pageId: input.pageId,
        summaryOnly: true,
        limit: HISTORY_PAGE_SIZE,
        ...(pageParam === undefined ? {} : { beforeRevision: pageParam }),
      }),
    getNextPageParam: (last) =>
      last.versions.length < HISTORY_PAGE_SIZE ? undefined : last.versions.at(-1)?.page.revision,
    enabled: input.enabled,
    retry: 1,
  });
}

function PanelStatus(props: {
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
  loadingLabel?: string;
  retryLabel?: string;
}) {
  const stalled = useStalled(props.loading);
  if (props.error)
    return (
      <div role="alert" className="flex flex-col items-start gap-2 text-ui-sm text-destructive">
        <p>{props.error.message || "加载失败"}</p>
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          {props.retryLabel ?? "重试"}
        </Button>
      </div>
    );
  if (!props.loading) return null;
  return (
    <div role="status" className="flex flex-col items-start gap-2 text-ui-sm text-muted-foreground">
      <p>{props.loadingLabel ?? (stalled ? "加载时间比平时长。" : "正在加载…")}</p>
      {stalled ? (
        <Button size="xs" variant="ghost" onClick={props.onRetry}>
          {props.retryLabel ?? "重试"}
        </Button>
      ) : null}
    </div>
  );
}

export function PageHistoryPanel(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  page: Page;
  busy: boolean;
  onRestore: (revision: number) => Promise<void>;
  /** 复制为新页面: a new page holding this version. */
  onCopy?: (revision: number) => Promise<void>;
}) {
  const translation = useTranslation();
  const [showChanges, setShowChanges] = useState(false);
  const versions = useVersionSummaries({
    account: props.account,
    scopeSpaceId: props.scopeSpaceId,
    pageId: props.page.id,
    revision: props.page.revision,
    enabled: true,
  });
  const [preview, setPreview] = useState<number | null>(null);
  const [now] = useState(() => Date.now());
  const body = useQuery({
    queryKey: [
      ...pagesQueryKeys.read(props.account, props.scopeSpaceId, props.page.id),
      "revision",
      preview,
    ],
    queryFn: () =>
      ensureNativeApi().pages.read({
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.page.id,
        revision: preview!,
      }),
    enabled: preview !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const list = versions.data?.pages.flatMap((page) => page.versions) ?? [];
  // The version before the one previewed: the next one down the list (newest first).
  const previewIndex = preview === null ? -1 : list.findIndex((v) => v.page.revision === preview);
  const previous = previewIndex >= 0 ? (list[previewIndex + 1] ?? null) : null;
  const previousBody = useQuery({
    queryKey: [
      ...pagesQueryKeys.read(props.account, props.scopeSpaceId, props.page.id),
      "revision",
      previous?.page.revision ?? null,
    ],
    queryFn: () =>
      ensureNativeApi().pages.read({
        scopeSpaceId: props.scopeSpaceId,
        pageId: props.page.id,
        revision: previous!.page.revision,
      }),
    enabled: showChanges && previous !== null,
    staleTime: Number.POSITIVE_INFINITY,
  });
  const changes = useMemo(
    () =>
      showChanges && body.data && (previous === null || previousBody.data)
        ? diffPageLines(previousBody.data?.content ?? "", body.data.content)
        : null,
    [showChanges, body.data, previous, previousBody.data],
  );
  return (
    <div className="flex flex-col gap-2" data-page-panel="history">
      <PanelStatus
        error={versions.error}
        loading={versions.isPending && versions.fetchStatus !== "idle"}
        onRetry={() => void versions.refetch()}
      />
      <ol className="flex flex-col gap-0.5" aria-label="版本历史">
        {list.map((version, index) => {
          const revision = version.page.revision;
          const open = preview === revision;
          const current = revision === props.page.revision;
          const day = historyDayLabel(version.createdAt);
          const firstOfDay = index === 0 || historyDayLabel(list[index - 1]!.createdAt) !== day;
          return (
            <li key={revision} className="rounded-row">
              {firstOfDay ? (
                <h3 className="px-2 pt-2 pb-1 text-ui-sm font-medium text-muted-foreground">
                  {day}
                </h3>
              ) : null}
              <button
                type="button"
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 rounded-row px-2 py-1.5 text-left hover:bg-accent",
                  open && "bg-accent",
                )}
                aria-expanded={open}
                onClick={() => setPreview(open ? null : revision)}
              >
                <span className="text-ui">
                  {versionActivity(version, translation)}
                  {current ? (
                    <span className="ms-1.5 text-ui-sm text-muted-foreground">当前</span>
                  ) : null}
                </span>
                <span
                  className="text-ui-sm text-muted-foreground"
                  title={new Date(version.createdAt).toLocaleString()}
                >
                  版本 {revision} · {formatRelativeTime(version.createdAt, now)}
                </span>
              </button>
              {open ? (
                <div className="mx-2 mt-1 mb-2 flex flex-col gap-2 rounded-card border border-border p-3">
                  {body.data && changes ? (
                    <div
                      className="max-h-72 overflow-auto font-mono text-ui-sm whitespace-pre-wrap"
                      aria-label="与上一版本相比的更改"
                      data-page-version-diff
                    >
                      {changes.every((line) => line.kind === "same") ? (
                        <p className="font-sans text-muted-foreground">
                          与上一版本相比没有文字更改。
                        </p>
                      ) : (
                        changes.map((line, lineIndex) => (
                          <div
                            key={lineIndex}
                            data-diff={line.kind}
                            className={cn(
                              "min-h-5 px-1",
                              line.kind === "added" && "bg-success/12",
                              line.kind === "removed" &&
                                "bg-destructive/12 text-muted-foreground line-through",
                              line.kind === "same" && "text-muted-foreground",
                            )}
                          >
                            {line.kind === "added" ? "+ " : line.kind === "removed" ? "− " : "  "}
                            {line.text}
                          </div>
                        ))
                      )}
                    </div>
                  ) : body.data && !showChanges ? (
                    <div className="max-h-72 overflow-auto text-ui-sm">
                      <ChatMarkdown text={body.data.content || "空页面"} cwd={undefined} />
                    </div>
                  ) : (
                    <PanelStatus
                      error={body.error}
                      loading={body.isPending}
                      onRetry={() => void body.refetch()}
                    />
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    <Button
                      size="xs"
                      variant="outline"
                      disabled={props.busy || current || props.page.trashedAt !== null}
                      onClick={() => void props.onRestore(revision)}
                    >
                      恢复此版本
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      aria-pressed={showChanges}
                      onClick={() => setShowChanges(!showChanges)}
                      data-page-version-changes
                    >
                      {showChanges ? "隐藏更改" : "显示更改"}
                    </Button>
                    {props.onCopy ? (
                      <Button
                        size="xs"
                        variant="ghost"
                        disabled={props.busy}
                        onClick={() => void props.onCopy?.(revision)}
                      >
                        复制为新页面
                      </Button>
                    ) : null}
                  </div>
                  {current ? null : (
                    <p className="text-ui-sm text-muted-foreground">
                      恢复会以这个版本的内容新建一个版本，当前内容仍保留在历史里。
                    </p>
                  )}
                </div>
              ) : null}
            </li>
          );
        })}
      </ol>
      {versions.hasNextPage ? (
        <Button
          size="xs"
          variant="ghost"
          className="self-start"
          disabled={versions.isFetchingNextPage}
          onClick={() => void versions.fetchNextPage()}
        >
          {versions.isFetchingNextPage ? "正在加载…" : "加载更早的版本"}
        </Button>
      ) : null}
    </div>
  );
}

export interface PageCommentSourceStatus {
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
}

function PageCommentStatuses(props: {
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
}) {
  const { t } = useTranslation();
  return (
    <>
      <PanelStatus
        {...props.localStatus}
        error={props.localStatus.error ? new Error(t("page.comments.localError")) : null}
        loadingLabel={t("page.comments.localLoading")}
        retryLabel={t("page.comments.retry")}
      />
      <PanelStatus
        {...props.shareStatus}
        error={props.shareStatus.error ? new Error(t("page.comments.sharedError")) : null}
        loadingLabel={t("page.comments.sharedLoading")}
        retryLabel={t("page.comments.retry")}
      />
    </>
  );
}

function commentAuthorLabel(
  comment: PageCommentFeedItem,
  translation: ReturnType<typeof useTranslation>,
) {
  if (comment.authorKind === "owner") return translation.t("page.comments.you");
  if (comment.authorKind === "agent") return translation.t("page.comments.agent");
  return guestCommentAuthorLabel(
    { authorKind: comment.authorKind, authorName: comment.authorName ?? "" },
    translation,
  );
}

type ThreadFilter = "all" | "open" | "resolved";
const THREAD_FILTERS: readonly { id: ThreadFilter; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "open", label: "未解决" },
  { id: "resolved", label: "已解决" },
];

/** Comments on words in the page: one row per thread, newest first; a click opens its card. */
export function PageThreadList(props: {
  threads: readonly PageComment[];
  focusedThreadId: string | null;
  onOpen: (threadId: string) => void;
  onResolve: (threadId: string, resolved: boolean) => void;
}) {
  const [filter, setFilter] = useState<ThreadFilter>("open");
  const [now] = useState(() => Date.now());
  const shown = [...props.threads]
    .filter((thread) =>
      filter === "all" ? true : filter === "open" ? !thread.resolved : thread.resolved === true,
    )
    .reverse();
  return (
    <section className="flex flex-col gap-2" aria-label="文字评论" data-page-thread-list>
      <div className="flex items-center gap-1" role="tablist" aria-label="筛选评论">
        {THREAD_FILTERS.map((entry) => (
          <Button
            key={entry.id}
            size="xs"
            variant="ghost"
            role="tab"
            aria-selected={filter === entry.id}
            className={cn(
              "text-muted-foreground",
              filter === entry.id && "bg-accent text-foreground",
            )}
            onClick={() => setFilter(entry.id)}
          >
            {entry.label}
          </Button>
        ))}
      </div>
      {shown.length === 0 ? (
        <p className="text-ui-sm text-muted-foreground">
          {filter === "resolved" ? "还没有已解决的评论。" : "选中页面里的文字，点“评论”即可评论。"}
        </p>
      ) : (
        <ol className="flex flex-col gap-1">
          {shown.map((thread) => {
            const agentWorking = thread.replies.some(
              (reply) => reply.kind === "agent" && reply.status === "thinking",
            );
            const last = thread.replies.at(-1);
            return (
              <li key={thread.id}>
                <div
                  className={cn(
                    "group flex flex-col gap-1 rounded-card border border-border p-3 hover:bg-accent/50",
                    props.focusedThreadId === thread.id && "border-ring",
                  )}
                  data-page-thread={thread.id}
                >
                  <Button
                    variant="ghost"
                    className="h-auto flex-col items-start gap-1 p-0 text-left font-normal whitespace-normal hover:bg-transparent"
                    onClick={() => props.onOpen(thread.id)}
                  >
                    <span className="line-clamp-2 border-s-2 border-border ps-2 text-ui-sm text-muted-foreground">
                      {thread.anchor.text}
                    </span>
                    <span className="text-ui-sm text-muted-foreground">
                      {thread.author.name} · {formatRelativeTime(thread.createdAt, now)}
                      {thread.replies.length ? ` · ${thread.replies.length} 条回复` : ""}
                      {agentWorking ? " · Moss 正在处理…" : ""}
                    </span>
                    <span className="line-clamp-3 text-ui whitespace-pre-wrap">
                      {thread.sentToAgentAt ? <span className="text-primary">@Moss </span> : null}
                      {thread.body}
                    </span>
                    {last && last.kind === "agent" && last.status === "done" ? (
                      <span className="line-clamp-2 text-ui-sm text-muted-foreground">
                        Moss：{last.body}
                      </span>
                    ) : null}
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    className="self-start"
                    onClick={() => props.onResolve(thread.id, !thread.resolved)}
                  >
                    {thread.resolved ? "重新打开" : "解决"}
                  </Button>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

export function PageCommentsPanel(props: {
  comments: readonly PageCommentFeedItem[];
  /** Comments on words in the page (kept on this device); omitted where the page has none. */
  threads?: {
    items: readonly PageComment[];
    focusedThreadId: string | null;
    onOpen: (threadId: string) => void;
    onResolve: (threadId: string, resolved: boolean) => void;
  };
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
  readOnly: boolean;
  busy: boolean;
  onReplyGuest: () => void;
  onSubmit: (content: string) => Promise<boolean>;
}) {
  const translation = useTranslation();
  const { t } = translation;
  const [draft, setDraft] = useState("");
  const [now] = useState(() => Date.now());
  return (
    <div className="flex flex-col gap-3" data-page-panel="comments">
      {props.threads ? (
        <>
          <PageThreadList
            threads={props.threads.items}
            focusedThreadId={props.threads.focusedThreadId}
            onOpen={props.threads.onOpen}
            onResolve={props.threads.onResolve}
          />
          <h3 className="mt-1 text-ui-sm font-medium text-muted-foreground">整页评论</h3>
        </>
      ) : null}
      <PageCommentStatuses localStatus={props.localStatus} shareStatus={props.shareStatus} />
      {props.comments.length === 0 &&
      !props.localStatus.loading &&
      !props.shareStatus.loading &&
      !props.localStatus.error &&
      !props.shareStatus.error ? (
        <p className="text-ui-sm text-muted-foreground">{t("page.comments.empty")}</p>
      ) : (
        <div role="list" aria-label={t("page.comments.label")} className="flex flex-col gap-2">
          {props.comments.map((entry) => (
            <div key={entry.key} role="listitem" className="rounded-card border border-border p-3">
              <p className="mb-1 text-ui-sm text-muted-foreground">
                {commentAuthorLabel(entry, translation)} ·{" "}
                {formatRelativeTime(entry.createdAt, now)}
                {entry.source === "share" ? ` · ${t("page.comments.shared")}` : ""}
              </p>
              <p className="text-ui whitespace-pre-wrap">{entry.content}</p>
              {entry.source === "share" && !props.readOnly ? (
                <Button size="xs" variant="ghost" onClick={props.onReplyGuest}>
                  {t("page.comments.replyGuest")}
                </Button>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {props.readOnly ? null : (
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            const content = draft.trim();
            if (!content) return;
            void props.onSubmit(content).then((sent) => {
              if (sent) setDraft("");
            });
          }}
        >
          <textarea
            className="min-h-20 w-full rounded-control border border-border bg-transparent px-2.5 py-2 text-ui outline-none focus:ring-2 focus:ring-ring"
            aria-label={t("page.comments.submit")}
            placeholder={t("page.comments.new")}
            maxLength={10_000}
            value={draft}
            disabled={props.busy}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            size="sm"
            type="submit"
            className="self-end"
            disabled={props.busy || !draft.trim()}
          >
            {t("page.comments.submit")}
          </Button>
        </form>
      )}
    </div>
  );
}

export function PageActivityPanel(props: {
  account: string;
  scopeSpaceId: SpaceId | null;
  page: Page;
  comments: readonly PageCommentFeedItem[];
  localStatus: PageCommentSourceStatus;
  shareStatus: PageCommentSourceStatus;
}) {
  const translation = useTranslation();
  const versions = useVersionSummaries({
    account: props.account,
    scopeSpaceId: props.scopeSpaceId,
    pageId: props.page.id,
    revision: props.page.revision,
    enabled: true,
  });
  const [now] = useState(() => Date.now());
  const entries = useMemo(() => {
    const changes = (versions.data?.pages.flatMap((page) => page.versions) ?? [])
      .filter((version) => version.operation !== "comment")
      .map((version) => ({
        key: `v${version.page.revision}`,
        at: version.createdAt,
        text: versionActivity(version, translation),
      }));
    const comments = props.comments.map((comment) => ({
      key: comment.key,
      at: comment.createdAt,
      text: translation.format("page.comments.activity", {
        author: commentAuthorLabel(comment, translation),
        content: comment.content.slice(0, 80),
      }),
    }));
    return [...changes, ...comments].toSorted((a, b) => b.at.localeCompare(a.at));
  }, [props.comments, versions.data, translation]);
  return (
    <div className="flex flex-col gap-2" data-page-panel="activity">
      <PanelStatus
        error={versions.error}
        loading={versions.isPending && versions.fetchStatus !== "idle"}
        onRetry={() => void versions.refetch()}
      />
      <PageCommentStatuses localStatus={props.localStatus} shareStatus={props.shareStatus} />
      <ol className="flex flex-col" aria-label="页面动态">
        {entries.map((entry) => (
          <li key={entry.key} className="flex gap-2 border-l border-border py-1.5 ps-3">
            <span className="min-w-0 flex-1 text-ui">{entry.text}</span>
            <span className="shrink-0 text-ui-sm text-muted-foreground">
              {formatRelativeTime(entry.at, now)}
            </span>
          </li>
        ))}
      </ol>
      <p className="text-ui-sm text-muted-foreground">
        创建于 {new Date(props.page.createdAt).toLocaleString()} · 编辑于{" "}
        {new Date(props.page.updatedAt).toLocaleString()}
      </p>
    </div>
  );
}

export function PageFilesPanel(props: {
  page: Page;
  items: readonly LibraryItem[] | undefined;
  error: Error | null;
  loading: boolean;
  onRetry: () => void;
  busy: boolean;
  onToggle: (itemId: string, attached: boolean) => void;
  onOpenLibrary: () => void;
}) {
  const live = (props.items ?? []).filter((item) => !item.trashedAt);
  const attached = live.filter((item) => props.page.assetIds.includes(item.id));
  const others = live.filter((item) => !props.page.assetIds.includes(item.id));
  return (
    <div className="flex flex-col gap-3" data-page-panel="files">
      <PanelStatus error={props.error} loading={props.loading} onRetry={props.onRetry} />
      <p className="text-ui-sm text-muted-foreground">
        关联资料库中的文件。文件本身仍由资料库保管。
      </p>
      {[
        ["已关联", attached],
        ["资料库", others],
      ].map(([label, list]) =>
        (list as LibraryItem[]).length ? (
          <section key={label as string} className="flex flex-col gap-0.5">
            <h3 className="px-1 text-ui-sm text-muted-foreground">{label as string}</h3>
            {(list as LibraryItem[]).map((item) => (
              <label
                key={item.id}
                className="flex h-8 items-center gap-2 rounded-row px-1 text-ui hover:bg-accent"
              >
                <input
                  type="checkbox"
                  className="size-4"
                  checked={props.page.assetIds.includes(item.id)}
                  disabled={props.busy || props.page.trashedAt !== null}
                  onChange={(event) => props.onToggle(item.id, event.target.checked)}
                />
                <span className="min-w-0 truncate">{item.title}</span>
              </label>
            ))}
          </section>
        ) : null,
      )}
      <Button size="xs" variant="ghost" className="self-start" onClick={props.onOpenLibrary}>
        打开资料库 / 导入文件
      </Button>
    </div>
  );
}

/** Headings of the page's Markdown projection, for the outline. */
export function pageOutline(markdown: string): { line: number; level: number; text: string }[] {
  const outline: { line: number; level: number; text: string }[] = [];
  let inCode = false;
  for (const [line, text] of markdown.split(/\r?\n/).entries()) {
    if (/^\s*```/.test(text)) inCode = !inCode;
    if (inCode) continue;
    const match = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(text);
    if (match)
      outline.push({ line, level: match[1]!.length, text: match[2]!.replace(/[*_`]/g, "") });
  }
  return outline;
}

export function PageNavigationPanel(props: {
  page: Page;
  pages: readonly Page[];
  markdown: string;
  onSelect: (pageId: PageId) => void;
}) {
  const outline = pageOutline(props.markdown);
  const ancestors: Page[] = [];
  const seen = new Set<PageId>([props.page.id]);
  let parent = props.page.parentPageId;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const entry = props.pages.find((item) => item.id === parent);
    if (!entry) break;
    ancestors.unshift(entry);
    parent = entry.parentPageId;
  }
  const children = props.pages.filter(
    (item) => item.parentPageId === props.page.id && item.trashedAt === null,
  );
  const link = (entry: Page) => (
    <button
      key={entry.id}
      type="button"
      className="flex h-7 w-full items-center truncate rounded-row px-2 text-left text-ui hover:bg-accent"
      onClick={() => props.onSelect(entry.id)}
    >
      {entry.title}
    </button>
  );
  return (
    <nav className="flex flex-col gap-3" aria-label="页面导航" data-page-panel="navigation">
      {ancestors.length ? (
        <section className="flex flex-col gap-0.5">
          <h3 className="px-2 text-ui-sm text-muted-foreground">上级页面</h3>
          {ancestors.map(link)}
        </section>
      ) : null}
      <section className="flex flex-col gap-0.5">
        <h3 className="px-2 text-ui-sm text-muted-foreground">大纲</h3>
        {outline.length ? (
          outline.map((entry) => (
            <p
              key={entry.line}
              className="truncate px-2 py-1 text-ui"
              style={{ paddingInlineStart: `${8 + (entry.level - 1) * 12}px` }}
            >
              {entry.text}
            </p>
          ))
        ) : (
          <p className="px-2 text-ui-sm text-muted-foreground">添加标题后，这里会显示大纲。</p>
        )}
      </section>
      <section className="flex flex-col gap-0.5">
        <h3 className="px-2 text-ui-sm text-muted-foreground">子页面</h3>
        {children.length ? (
          children.map(link)
        ) : (
          <p className="px-2 text-ui-sm text-muted-foreground">没有子页面</p>
        )}
      </section>
    </nav>
  );
}
